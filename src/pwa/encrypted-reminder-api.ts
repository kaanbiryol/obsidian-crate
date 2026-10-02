import { openFile, sealFile } from '../encryption/file-codec';
import { decryptJson, encryptJson } from '../encryption/envelope';
import { createReminderProjectionWithKeys } from '../encryption/reminder-projection';
import { scanReminderMarkdownContent, getProjectFromPath } from '../reminders/core/markdownScan';
import { decodeMarkdownBytes } from '../reminders/core/markdownEncoding';
import { applyReminderFileCommand, reminderCommandPayload, ReminderCommandError } from '../reminders/core/reminderFileCommand';
import { computeHash } from '../sync/hasher';
import { reminderRequestHash } from '../encryption/reminder-receipt';
import { MarkdownEncodingError } from '../reminders/core/markdownEncoding';
import { ReminderInputError } from '../reminders/core/reminderMutationInput';
import { ReminderMarkdownContextError } from '../reminders/core/markdownTaskContext';
import { validateEncryptedSchedules, ENCRYPTED_SCHEDULING_CAPACITY_ISSUE } from '../encryption/notification-format';
import { capturePwaSession } from './session-generation';
import { loadEncryptedReminderAttempt, saveEncryptedReminderAttempt, pruneEncryptedReminderAttempts, type EncryptedReminderAttempt as Attempt } from './encrypted-reminder-attempts';
import { requireCompatibleServer } from './server-compatibility';
import type { StoredReminderKeys } from './encryption-keys';
import type { ApiFetch, ReminderSourceIssue } from './types';
import { routeFolderPath } from './encryption-folder-routing';

interface RemoteFile { path: string; hash: string; size: number; revision: string }
interface FilePage { files: RemoteFile[]; sequence: number; generation: number; nextCursor: string | null }

async function json<T>(response: Response): Promise<T> {
	if (!response.ok) {
		const value = await response.json().catch(() => ({})) as { error?: string; code?: string };
		throw new ReminderCommandError(value.error ?? 'Could not read encrypted reminders', response.status, value.code ?? 'storage');
	}
	return response.json() as Promise<T>;
}

export class EncryptedReminderApi {
	private readonly current = capturePwaSession();
	private readonly cached = new Map<string, { file: RemoteFile; content: string; issue?: string }>();
	constructor(private readonly keys: StoredReminderKeys, private readonly fetch: ApiFetch) {}
	private get localFolder() { return this.keys.localFolderPath ?? this.keys.folderPath; }
	private authority(path: string) {
		if (!path.startsWith(`${this.keys.folderPath}/`) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new ReminderCommandError('File is outside this enrollment', 403, 'scope_mismatch');
		return { vaultId: this.keys.vaultId, scopeId: this.keys.scopeId, key: this.keys.data };
	}
	private assertCurrent(): void { if (!this.current()) throw new Error('Session changed. Reopen Crate before saving.'); }
	private context(operationId: string) { return { vaultId: this.keys.vaultId, scopeId: this.keys.scopeId, objectId: operationId, purpose: 'reminder' as const }; }
	private attemptKey(operationId: string) { return `${this.keys.vaultId}:${this.keys.scopeId}:${operationId}`; }

	async handle(path: string, init: RequestInit = {}): Promise<Response | null> {
		if (path === '/links/title') return Response.json({ title: null });
		const url = new URL(path, 'https://crate.invalid');
		if (url.pathname === '/reminders/list') {
			if (url.searchParams.get('folderPath') !== this.localFolder) return Response.json({ error: 'Folder does not match this enrollment' }, { status: 403 });
			return this.list(new Headers(init.headers).get('If-None-Match'));
		}
		if (!['/reminders/create', '/reminders/update', '/reminders/set-completed', '/reminders/delete', '/reminders/reorder'].includes(url.pathname)) return null;
		if (typeof init.body !== 'string') throw new Error('Missing reminder change');
		try { return await this.mutate(url.pathname.slice('/reminders/'.length), init.body); }
		catch (error) {
			if (error instanceof ReminderCommandError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
			if (error instanceof ReminderInputError) return Response.json({ error: error.message, code: 'invalid_reminder_input' }, { status: 400 });
			if (error instanceof ReminderMarkdownContextError) return Response.json({ error: error.message, code: 'reminder_markdown_context' }, { status: 409 });
			throw error;
		}
	}

	private async page(after?: string): Promise<FilePage> {
		const query = new URLSearchParams({ folderPath: this.keys.folderPath });
		if (after) query.set('after', after);
		const page = await json<FilePage>(await this.fetch(`/reminders/encrypted-files?${query}`));
		if (page.generation !== this.keys.generation || !Number.isSafeInteger(page.sequence) || page.sequence < 0
			|| !Array.isArray(page.files) || page.files.length > 100 || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) throw new Error('Invalid encrypted file inventory');
		for (const file of page.files) {
			if (!file || typeof file.path !== 'string' || typeof file.hash !== 'string' || !/^[a-f0-9]{64}$/.test(file.hash)
				|| !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.revision !== 'string' || !file.revision) throw new Error('Invalid encrypted file metadata');
			this.authority(file.path);
		}
		return page;
	}

	private async inventory(first?: FilePage): Promise<{ files: RemoteFile[]; sequence: number }> {
		const files: RemoteFile[] = [];
		let cursor: string | undefined, sequence: number | undefined;
		const seen = new Set<string>();
		while (true) {
			const page = first ?? await this.page(cursor);
			first = undefined;
			sequence ??= page.sequence;
			if (page.sequence !== sequence) throw new ReminderCommandError('Reminder files changed while loading. Refresh again.');
			files.push(...page.files);
			if (files.length > 20000) throw new Error('This reminders folder exceeds the web app file limit');
			if (!page.nextCursor) break;
			if (seen.has(page.nextCursor) || (cursor && page.nextCursor <= cursor)) throw new Error('Encrypted file pagination did not advance');
			cursor = page.nextCursor; seen.add(cursor);
		}
		if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('Encrypted inventory repeated a file');
		return { files, sequence: sequence };
	}

	private async read(file: RemoteFile): Promise<string> {
		const cached = this.cached.get(file.revision);
		if (cached && cached.file.path === file.path && cached.file.hash === file.hash) return cached.content;
		if (file.size > 4 * 1024 * 1024) throw new ReminderCommandError('Split this note into files of 1 MiB or smaller to use its reminders.', 413, 'file_too_large');
		const query = new URLSearchParams({ folderPath: this.keys.folderPath, path: file.path, revision: file.revision });
		const response = await this.fetch(`/reminders/encrypted-file?${query}`);
		if (!response.ok) await json(response);
		const bytes = await response.arrayBuffer();
		if (bytes.byteLength !== file.size || await computeHash(bytes) !== file.hash) throw new Error('Encrypted reminder transfer failed integrity validation');
		const opened = await openFile(new Uint8Array(bytes), file.path, this.authority(file.path));
		if (opened.content.byteLength > 1024 * 1024) throw new ReminderCommandError('Split this note into files of 1 MiB or smaller to use its reminders.', 413, 'file_too_large');
		const content = decodeMarkdownBytes(opened.content);
		validateEncryptedSchedules(opened.publicData);
		const issue = opened.publicData.issue === 'scheduling-capacity' ? ENCRYPTED_SCHEDULING_CAPACITY_ISSUE : undefined;
		this.assertCurrent();
		this.cached.set(file.revision, { file, content, issue });
		let bytesCached = [...this.cached.values()].reduce((bytes, entry) => bytes + entry.content.length * 2, 0);
		while (bytesCached > 16 * 1024 * 1024 || this.cached.size > 1000) {
			const first = this.cached.keys().next().value!;
			bytesCached -= this.cached.get(first)!.content.length * 2; this.cached.delete(first);
		}
		return content;
	}

	private async list(previousEtag: string | null): Promise<Response> {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const first = await this.page();
				this.assertCurrent();
				this.cleanup();
				const etag = `"e2ee-${this.keys.vaultId}-${this.keys.scopeId}-${this.keys.generation}-${first.sequence}"`;
				if (etag === previousEtag) return new Response(null, { status: 304, headers: { ETag: etag } });
				const inventory = await this.inventory(first);
				const reminders: Awaited<ReturnType<typeof reminderCommandPayload>>[] = [], issues: ReminderSourceIssue[] = [];
				const projects = new Set<string>();
				for (const file of inventory.files) {
					projects.add(getProjectFromPath(file.path, this.keys.folderPath));
					try {
						const scanned = scanReminderMarkdownContent(routeFolderPath(file.path, this.keys.folderPath, this.localFolder), await this.read(file), this.localFolder).reminders;
						const issue = this.cached.get(file.revision)?.issue;
						if (issue) issues.push({ path: routeFolderPath(file.path, this.keys.folderPath, this.localFolder), reason: issue });
						for (const reminder of scanned) reminders.push(await reminderCommandPayload(reminder));
					} catch (error) {
						if (!(error instanceof MarkdownEncodingError) && !(error instanceof ReminderCommandError && error.status === 413)) throw error;
						issues.push({ path: routeFolderPath(file.path, this.keys.folderPath, this.localFolder), reason: error instanceof Error ? error.message : 'This note could not be decrypted' });
					}
				}
				if ((await this.page()).sequence !== inventory.sequence) throw new ReminderCommandError('Reminder files changed while loading. Refresh again.');
				const counts = new Map<string, number>();
				for (const reminder of reminders) counts.set(reminder.id, (counts.get(reminder.id) ?? 0) + 1);
				for (const reminder of reminders) if (counts.get(reminder.id)! > 1) issues.push({ path: reminder.filePath, reason: 'Duplicate reminder identity. Repair this note in Obsidian.' });
				this.assertCurrent();
				return Response.json({ reminders: reminders.filter(reminder => counts.get(reminder.id) === 1), projects: [...projects].sort(), issues }, { headers: { ETag: etag } });
			} catch (error) {
				if (!(error instanceof ReminderCommandError) || error.status !== 409 || attempt === 2) throw error;
			}
		}
		throw new Error('Reminder inventory could not converge');
	}

	private cleanupCursor?: string;
	private cleanupRunning = false;
	private lastCleanup?: number;
	private cleanup(): void {
		if (this.cleanupRunning || !navigator.locks || !this.current()) return;
		const now = Date.now();
		if (this.lastCleanup !== undefined && now >= this.lastCleanup && now - this.lastCleanup < 5 * 60_000) return;
		this.lastCleanup = now;
		this.cleanupRunning = true;
		void requireCompatibleServer().then(info => navigator.locks.request('crate-reminder-outbox', { ifAvailable: true }, async lock => {
			if (lock && info.reminderOperationDay !== undefined) this.cleanupCursor = await pruneEncryptedReminderAttempts(this.keys, info.reminderOperationDay, this.current, this.cleanupCursor);
		})).catch(() => { /* Cleanup failure never blocks reminders or changes pending work. */ })
			.finally(() => { this.cleanupRunning = false; });
	}

	private async mutate(action: string, source: string): Promise<Response> {
		const original = JSON.parse(source) as Record<string, unknown>;
		if (original.folderPath !== this.localFolder || typeof original.operationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(original.operationId)) throw new ReminderCommandError('Invalid encrypted reminder operation', 400, 'invalid_reminder_input');
		const body = { ...original, operationId: original.operationId };
		const key = this.attemptKey(body.operationId);
		const semanticHash = await computeHash(new TextEncoder().encode(JSON.stringify([action, source])).buffer);
		let attempt = await loadEncryptedReminderAttempt(key);
		if (attempt && attempt.semanticHash !== semanticHash && !attempt.rejected) throw new Error('The original encrypted save is still unresolved. Retry it before changing the request.');
		const movedAttempt = attempt && (attempt.generation !== undefined ? attempt.generation !== this.keys.generation
			: (JSON.parse(attempt.body) as { folderPath: string }).folderPath !== this.keys.folderPath);
		if (attempt?.acknowledgment) return Response.json(await decryptJson(attempt.acknowledgment, this.keys.data, this.context(body.operationId)));
		if (!attempt || movedAttempt) {
			const query = new URLSearchParams({ folderPath: this.keys.folderPath, operationId: body.operationId });
			const receipt = await json<{ envelope: string | null }>(await this.fetch(`/reminders/encrypted-receipt?${query}`));
			if (receipt.envelope) {
				const legacy = await decryptJson(receipt.envelope, this.keys.data, this.context(body.operationId)) as { requestHash: string; response: unknown };
				if (legacy.requestHash !== await reminderRequestHash(attempt ? 'encrypted-files' : action === 'set-completed' ? 'complete' : action,
					attempt ? JSON.parse(attempt.body) as Record<string, unknown> : original)) throw new ReminderCommandError('The original reminder operation has different saved content. Preserve it before recovery.', 409, 'operation_mismatch');
				const encrypted = (legacy.response as { encrypted?: unknown })?.encrypted;
				return Response.json(typeof encrypted === 'string' ? await decryptJson(encrypted, this.keys.data, this.context(body.operationId)) : legacy.response);
			}
			if (attempt) {
				// The old generation can no longer publish. An absent converted receipt
				// confirms this immutable attempt never committed; retain its semantic ID.
				const rejected = { ...attempt, rejected: true };
				await saveEncryptedReminderAttempt(key, rejected, attempt, this.current); attempt = rejected;
			}
		}
		for (let retry = 0; retry < 2; retry++) {
			if (!attempt || attempt.rejected) {
				const inventory = await this.inventory();
				const files = new Map(inventory.files.map(file => [file.path, file]));
				const command = await applyReminderFileCommand(action, body, this.localFolder, async path => {
					const file = files.get(routeFolderPath(path, this.localFolder, this.keys.folderPath));
					return file ? this.read(file) : null;
				});
				const replacements = [];
				for (const change of command.files) {
					const path = routeFolderPath(change.path, this.localFolder, this.keys.folderPath);
					const content = new TextEncoder().encode(change.content);
					const projection = await createReminderProjectionWithKeys(this.keys.vaultId, { id: this.keys.scopeId, folderPath: this.keys.folderPath },
						this.keys.notifications, this.keys.notificationFingerprint, path, content.buffer);
					const sealed = await sealFile({ path, content, contentType: 'text/markdown; charset=utf-8', publicData: projection }, this.authority(path));
					replacements.push({ path, content: new TextDecoder().decode(sealed.bytes),
						expectedHash: files.get(path)?.hash ?? null, expectedRevision: files.get(path)?.revision });
				}
				const acknowledgment = await encryptJson(command.response, this.keys.data, this.context(body.operationId));
				const next: Attempt = { semanticHash, generation: this.keys.generation, body: JSON.stringify({ folderPath: this.keys.folderPath, operationId: body.operationId,
					files: replacements, acknowledgment, ...(command.createdId ? { createdId: command.createdId } : {}) }) };
				await saveEncryptedReminderAttempt(key, next, attempt, this.current); attempt = next;
			}
			this.assertCurrent();
			if (attempt.acknowledgment) return Response.json(await decryptJson(attempt.acknowledgment, this.keys.data, this.context(body.operationId)));
			const response = await this.fetch('/reminders/encrypted-commit', { method: 'POST', body: attempt.body });
			if (response.status === 409) {
				const details = await response.clone().json() as { code?: string };
				if (details.code === 'version_conflict') {
					const rejected = { ...attempt, rejected: true };
					await saveEncryptedReminderAttempt(key, rejected, attempt, this.current); attempt = rejected;
					if (retry === 0) continue;
				}
			}
			if (!response.ok) return response;
			const ack = await response.json() as { encrypted?: string };
			if (typeof ack.encrypted !== 'string') throw new Error('The server did not confirm the encrypted save');
			const result = await decryptJson(ack.encrypted, this.keys.data, this.context(body.operationId));
			await saveEncryptedReminderAttempt(key, { ...attempt, acknowledgment: ack.encrypted }, attempt, this.current);
			return Response.json(result);
		}
		throw new Error('Encrypted save could not converge');
	}
}
