import { sealFile } from '../../encryption/file-codec';
import { decryptJson, encryptJson } from '../../encryption/envelope';
import { createReminderProjection } from '../../encryption/reminder-projection';
import { scanReminderMarkdownContent, getProjectFromPath } from '../../reminders/core/markdownScan';
import { decodeMarkdownBytes } from '../../reminders/core/markdownEncoding';
import { buildReminderList } from '../../reminders/core/reminder-list';
import { applyReminderFileCommand, reminderCommandPayload, ReminderCommandError } from '../../reminders/core/reminderFileCommand';
import { MarkdownEncodingError } from '../../reminders/core/markdownEncoding';
import { ReminderInputError } from '../../reminders/core/reminderMutationInput';
import { ReminderMarkdownContextError } from '../../reminders/core/markdownTaskContext';
import { MAX_REMINDER_NOTE_BYTES } from '../../reminders/core/constants';
import { validateEncryptedSchedules, ENCRYPTED_SCHEDULING_CAPACITY_ISSUE } from '../../encryption/notification-format';
import { capturePwaSession } from '../connection/session-generation';
import { loadEncryptedReminderAttempt, loadEncryptedReminderIndex, saveEncryptedReminderAttempt, saveEncryptedReminderIndex, pruneEncryptedReminderAttempts, MAX_ENCRYPTED_REMINDER_FILES, type EncryptedReminderAttempt as Attempt } from './encrypted-reminder-attempts';
import { PWA_ASSET_VERSION } from '../shell/version';
import { requireCompatibleServer } from '../connection/server-compatibility';
import type { FeatureKeys } from '../encryption/encryption-keys';
import type { ApiFetch } from '../types';
import { encryptedInventoryPages, parseEncryptedInventoryPage, type EncryptedInventoryFile as RemoteFile, type EncryptedInventoryPage as FilePage, MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES, openVerifiedInventoryFile } from '../../encryption/file-inventory';
import { mapBounded } from '@/platform/map-bounded';
import { isReminderOperationId } from '@/protocol/reminder-operation';
import { isSyncPath } from '@/protocol/sync-validation';
import { REMINDER_OUTBOX_LOCK } from '@/pwa/reminders/private-storage';
import { sha256Hex } from '@/platform/sha256';
import { trimContentCache } from '@/pwa/storage/content-cache';
import { resolveEncryptedPath } from '@/encryption/path-binding';
import { compareCodePoints } from '@/protocol/initial-import';

const NOTE_CONCURRENCY = 6;
type ReminderPayload = Awaited<ReturnType<typeof reminderCommandPayload>>;
/** `file` is listed by server path; `path` is the note's plaintext path. */
interface ScannedNote { file: RemoteFile; path: string; reminders: ReminderPayload[]; issue?: string }

async function json<T>(response: Response): Promise<T> {
	if (!response.ok) {
		const value = await response.json().catch(() => ({})) as { error?: string; code?: string };
		throw new ReminderCommandError(value.error ?? 'Could not read encrypted reminders', response.status, value.code ?? 'storage');
	}
	return response.json() as Promise<T>;
}

export class EncryptedReminderApi {
	private readonly current = capturePwaSession();
	private cached = new Map<string, { file: RemoteFile; path: string; content: string; issue?: string }>();
	// Parsed reminders per immutable revision. Unlike the bounded content cache,
	// this keeps every current note, so a change re-downloads only changed notes.
	private scanned = new Map<string, ScannedNote>();
	// Plaintext path of each server path opened this session, for issues raised after opening.
	private names = new Map<string, string>();
	private indexLoaded = false;
	constructor(private readonly keys: FeatureKeys, private readonly fetch: ApiFetch) {}
	/** Notes, projects and requests from the app use plaintext paths; the server sees `wireFolder`. */
	private get localFolder() { return this.keys.folderPath; }
	private authority(wire: string) {
		if (!wire.startsWith(`${this.keys.wireFolder}/`) || !isSyncPath(wire)) throw new ReminderCommandError('File is outside this enrollment', 403, 'scope_mismatch');
		return { vaultId: this.keys.vaultId, scopeId: 'vault', key: this.keys.vault };
	}
	private assertCurrent(): void { if (!this.current()) throw new Error('Session changed. Reopen Crate before saving.'); }
	private get indexScope() { return `${this.keys.vaultId}:${this.keys.wireFolder}`; }
	private get indexIdentity() { return JSON.stringify([PWA_ASSET_VERSION, this.keys.vaultId, this.keys.generation, this.keys.wireFolder, this.keys.folderPath]); }
	/** Seed parsed notes from the last session's complete list once per instance. */
	private async loadIndex(): Promise<void> {
		if (this.indexLoaded) return;
		this.indexLoaded = true;
		try {
			for (const note of await loadEncryptedReminderIndex(this.indexScope, this.indexIdentity) ?? []) {
				if (!this.scanned.has(note.file.revision)) this.scanned.set(note.file.revision, note as ScannedNote);
			}
		} catch { /* A missing or unreadable index only costs downloads. */ }
	}
	private context(operationId: string) { return { vaultId: this.keys.vaultId, scopeId: 'vault', objectId: operationId, purpose: 'reminder' as const }; }
	private attemptKey(operationId: string) { return `${this.keys.vaultId}:vault:${operationId}`; }

	async handle(path: string, init: RequestInit = {}): Promise<Response | null> {
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
		const query = new URLSearchParams({ folderPath: this.keys.wireFolder });
		if (after) query.set('after', after);
		return parseEncryptedInventoryPage(await json<unknown>(await this.fetch(`/reminders/encrypted-files?${query}`)), this.keys.wireFolder, this.keys.generation);
	}

	private async inventory(first?: FilePage): Promise<{ files: RemoteFile[]; sequence: number }> {
		const files: RemoteFile[] = [];
		first ??= await this.page();
		for await (const page of encryptedInventoryPages(after => this.page(after), {
			maxFiles: MAX_ENCRYPTED_REMINDER_FILES, first,
			changed: () => new ReminderCommandError('Reminder files changed while loading. Refresh again.'),
		})) files.push(...page.files);
		return { files, sequence: first.sequence };
	}

	private async read(file: RemoteFile, cache = this.cached): Promise<string> {
		return (await this.readNote(file, cache)).content;
	}

	private async readNote(file: RemoteFile, cache: typeof this.cached): Promise<{ path: string; content: string; issue?: string }> {
		const cached = cache.get(file.revision);
		if (cached && cached.file.path === file.path && cached.file.hash === file.hash && cached.file.size === file.size) return cached;
		// Coarse ciphertext bound before download; the 1 MiB plaintext limit is checked after opening.
		if (file.size > MAX_ENCRYPTED_NOTE_DOWNLOAD_BYTES) throw new ReminderCommandError('Split this note into files of 1 MiB or smaller to use its reminders.', 413, 'file_too_large');
		const query = new URLSearchParams({ folderPath: this.keys.wireFolder, path: file.path, revision: file.revision });
		const response = await this.fetch(`/reminders/encrypted-file?${query}`);
		if (!response.ok) await json(response);
		const opened = await openVerifiedInventoryFile(new Uint8Array(await response.arrayBuffer()), file, this.authority(file.path),
			'Encrypted reminder transfer failed integrity validation', (metadataPath, sealed) => resolveEncryptedPath(this.keys.paths, file.path, metadataPath, sealed, null));
		this.names.set(file.path, opened.metadata.path);
		if (opened.content.byteLength > MAX_REMINDER_NOTE_BYTES) throw new ReminderCommandError('Split this note into files of 1 MiB or smaller to use its reminders.', 413, 'file_too_large');
		const content = decodeMarkdownBytes(opened.content);
		validateEncryptedSchedules(opened.publicData);
		const issue = opened.publicData.issue === 'scheduling-capacity' ? ENCRYPTED_SCHEDULING_CAPACITY_ISSUE : undefined;
		const path = opened.metadata.path;
		this.assertCurrent();
		cache.set(file.revision, { file, path, content, issue });
		trimContentCache(cache, 1000);
		return { path, content, issue };
	}

	private async list(previousEtag: string | null): Promise<Response> {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const first = await this.page();
				this.assertCurrent();
				this.cleanup();
				const etag = `"e2ee-${this.keys.vaultId}-${this.keys.generation}-${first.sequence}"`;
				if (etag === previousEtag) return new Response(null, { status: 304, headers: { ETag: etag } });
				await this.loadIndex();
				const inventory = await this.inventory(first);
				const nextCache = new Map(this.cached);
				const sources: Array<{ path: string; project: string; reminders: ReminderPayload[]; issue?: string }> = [];
				const nextScanned = new Map<string, ScannedNote>();
				const loaded = await mapBounded(inventory.files, NOTE_CONCURRENCY, async (file): Promise<ScannedNote | { file: RemoteFile; error: unknown }> => {
					try {
						const known = this.scanned.get(file.revision);
						if (known && known.file.path === file.path && known.file.hash === file.hash && known.file.size === file.size) return known;
						const note = await this.readNote(file, nextCache);
						const scanned = scanReminderMarkdownContent(note.path, note.content, this.localFolder).reminders;
						return { file, path: note.path, reminders: await Promise.all(scanned.map(reminder => reminderCommandPayload(reminder))), issue: note.issue };
					} catch (error) {
						if (!(error instanceof MarkdownEncodingError) && !(error instanceof ReminderCommandError && error.status === 413)) throw error;
						return { file, error };
					}
				});
				for (const entry of loaded) {
					const { file } = entry;
					// A note that could not even be opened is reported by its server path.
					const path = 'path' in entry ? entry.path : this.names.get(file.path) ?? file.path;
					const source = { path, project: getProjectFromPath(path, path === file.path ? this.keys.wireFolder : this.keys.folderPath) };
					if ('error' in entry) {
						sources.push({ ...source, reminders: [], issue: entry.error instanceof Error ? entry.error.message : 'This note could not be decrypted' });
						continue;
					}
					nextScanned.set(file.revision, entry);
					sources.push({ ...source, reminders: entry.reminders, issue: entry.issue });
				}
				if ((await this.page()).sequence !== inventory.sequence) throw new ReminderCommandError('Reminder files changed while loading. Refresh again.');
				// The server lists tags; order notes by plaintext path, as an unencrypted server does.
				sources.sort((a, b) => compareCodePoints(a.path, b.path));
				const result = buildReminderList(sources);
				this.assertCurrent();
				this.cached = nextCache;
				this.scanned = nextScanned;
				void saveEncryptedReminderIndex(this.indexScope, this.indexIdentity, [...nextScanned.values()], this.current).catch(() => {});
				return Response.json(result, { headers: { ETag: etag } });
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
		void requireCompatibleServer().then(info => navigator.locks.request(REMINDER_OUTBOX_LOCK, { ifAvailable: true }, async lock => {
			if (lock && info.reminderOperationDay !== undefined) this.cleanupCursor = await pruneEncryptedReminderAttempts(this.keys, info.reminderOperationDay, this.current, this.cleanupCursor);
		})).catch(() => { /* Cleanup failure never blocks reminders or changes pending work. */ })
			.finally(() => { this.cleanupRunning = false; });
	}

	private async mutate(action: string, source: string): Promise<Response> {
		const original = JSON.parse(source) as Record<string, unknown>;
		if (original.folderPath !== this.localFolder || !isReminderOperationId(original.operationId)) throw new ReminderCommandError('Invalid encrypted reminder operation', 400, 'invalid_reminder_input');
		const body = { ...original, operationId: original.operationId };
		const key = this.attemptKey(body.operationId);
		const semanticHash = await sha256Hex(new TextEncoder().encode(JSON.stringify([action, source])).buffer);
		let attempt = await loadEncryptedReminderAttempt(key);
		if (attempt && attempt.semanticHash !== semanticHash && !attempt.rejected) throw new Error('The original encrypted save is still unresolved. Retry it before changing the request.');
		const movedAttempt = attempt && attempt.generation !== this.keys.generation;
		if (attempt?.acknowledgment) return Response.json(await decryptJson(attempt.acknowledgment, this.keys.vault, this.context(body.operationId)));
		if (attempt && movedAttempt) {
			// Other keys can no longer publish, so this immutable attempt never committed; retain its semantic ID.
			const rejected = { ...attempt, rejected: true };
			await saveEncryptedReminderAttempt(key, rejected, attempt, this.current); attempt = rejected;
		}
		for (let retry = 0; retry < 2; retry++) {
			if (!attempt || attempt.rejected) {
				const inventory = await this.inventory();
				// Reminder notes are always created by key holders, so each lives at its name's tag.
				const files = new Map(inventory.files.map(file => [file.path, file]));
				const command = await applyReminderFileCommand(action, body, this.localFolder, async path => {
					const file = files.get(await this.keys.paths.wire(path));
					return file ? this.read(file) : null;
				});
				const replacements = [];
				for (const change of command.files) {
					const path = change.path, wire = await this.keys.paths.wire(path);
					const content = new TextEncoder().encode(change.content);
					const projection = await createReminderProjection({ vaultId: this.keys.vaultId, key: this.keys.notifications, fingerprint: this.keys.notificationFingerprint },
						[this.keys.folderPath], path, content.buffer);
					const sealed = await sealFile({ path, content, contentType: 'text/markdown; charset=utf-8', publicData: projection }, this.authority(wire));
					replacements.push({ path: wire, content: new TextDecoder().decode(sealed.bytes),
						expectedHash: files.get(wire)?.hash ?? null, expectedRevision: files.get(wire)?.revision });
				}
				const acknowledgment = await encryptJson(command.response, this.keys.vault, this.context(body.operationId));
				const next: Attempt = { semanticHash, generation: this.keys.generation, body: JSON.stringify({ folderPath: this.keys.wireFolder, operationId: body.operationId,
					files: replacements, acknowledgment, ...(command.createdId ? { createdId: command.createdId } : {}) }) };
				await saveEncryptedReminderAttempt(key, next, attempt, this.current); attempt = next;
			}
			this.assertCurrent();
			if (attempt.acknowledgment) return Response.json(await decryptJson(attempt.acknowledgment, this.keys.vault, this.context(body.operationId)));
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
			const result = await decryptJson(ack.encrypted, this.keys.vault, this.context(body.operationId));
			await saveEncryptedReminderAttempt(key, { ...attempt, acknowledgment: ack.encrypted }, attempt, this.current);
			return Response.json(result);
		}
		throw new Error('Encrypted save could not converge');
	}
}
