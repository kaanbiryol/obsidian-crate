import { INITIAL_IMPORT_CAPABILITY, INITIAL_IMPORT_PRUNE_MAX_FILES, importInventoryPages, type InitialImport, type ReminderSetupProgress, type ReminderSetupStatus } from '@/protocol/initial-import';
import { normalizeSyncIssues, SyncIssueError } from '../issues';
import type { BatchUploadResponse } from '@/protocol/sync-types';
import { transferTimeout, type WorkerApiHttpClient } from './http';
import { arrayBufferToBase64 } from '../encoding';
import type { PreparedUpload } from '../transfer/types';
import { BATCH_FILE_SIZE_LIMIT } from '@/protocol/sync-limits';
import { FILE_HASH_HEADER, EXPECTED_HASH_HEADER, INITIAL_IMPORT_HEADER } from '@/protocol/http-headers';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '@/encryption/file-format';
import { createPathRecord } from '@/protocol/path-record';
import type { EncryptedFiles } from '../encryption/encrypted-files';
import { chunkPreparedUploads } from '../transfer/prepare';
import { SyncWorkerApi } from './sync';
import type { FileEntry } from '@/protocol/sync-types';

/** A file of an encrypted import as the server stores it: its server path and ciphertext. */
interface WireFile { path: string; hash: string; size: number }
/** A file the import keeps, by plaintext path. `revision` names its server copy. */
export interface ImportInventoryFile { hash: string; size: number; revision?: string }

export class InitialImportApi {
	private establishedAt?: string;
	private pendingSetup?: { token: string; workerUrl: string };
	private encryption?: EncryptedFiles;
	/** Server copies of an encrypted import by revision: those this device uploaded, and
	 * the server listing once a file it did not upload needs translating. */
	private readonly wires = new Map<string, WireFile>();
	private listing?: Promise<void>;
	constructor(private http: WorkerApiHttpClient,
		private readonly readRawManifest: () => Promise<{ files: Record<string, FileEntry> }> = () => new SyncWorkerApi(http).getRawManifest()) {}

	/** An encrypted vault imports ciphertext: paths, hashes and sizes sent to the server are
	 * its own, and results come back in plaintext terms. */
	setEncryption(encryption: EncryptedFiles): void { this.encryption = encryption; }

	async begin(): Promise<InitialImport | null> {
		if (this.establishedAt === this.http.getWorkerUrl()) return null;
		const info = await this.http.getServerInfo();
		if (!info.capabilities.includes(INITIAL_IMPORT_CAPABILITY)) return null;
		const response = await this.http.requestJson<{ import: InitialImport | null }>('/sync/import', { method: 'POST' });
		if (response.import === null) { this.establishedAt = this.http.getWorkerUrl(); return null; }
		if (!response.import || typeof response.import.token !== 'string' || !['importing', 'complete'].includes(response.import.state)) throw new Error('Invalid initial import response');
		if (response.import.state === 'complete') this.pendingSetup = { token: response.import.token, workerUrl: this.http.getWorkerUrl() };
		return response.import;
	}

	/** `expectedRevision` names the server copy an upload replaces, when there is one. */
	async upload(token: string, files: Array<PreparedUpload & { expectedRevision?: string }>): Promise<BatchUploadResponse> {
		const encryption = this.encryption;
		if (!encryption) return this.send(token, files);
		const sealed = await Promise.all(files.map(async file => {
			const wire = await encryption.sealImport(file.path, file.content, file);
			const expected = file.expectedHash == null ? null : (await this.wireOf(file.expectedRevision))?.hash;
			if (expected === undefined) throw new Error('Initial upload changed. Sync again to resume.');
			const upload: PreparedUpload = { path: wire.wire, content: wire.content, hash: wire.hash, size: wire.size,
				contentType: ENCRYPTED_FILE_CONTENT_TYPE, expectedHash: expected };
			return { plain: file, wire, upload };
		}));
		// Ciphertext is larger than the plaintext the batch was sized by.
		const results: BatchUploadResponse['results'] = [];
		const small = sealed.filter(file => file.upload.size < BATCH_FILE_SIZE_LIMIT).map(file => file.upload);
		for (const batch of chunkPreparedUploads(small, files.length)) results.push(...(await this.send(token, batch)).results);
		for (const file of sealed.filter(file => file.upload.size >= BATCH_FILE_SIZE_LIMIT)) results.push(...(await this.send(token, [file.upload])).results);
		const byWire = new Map(sealed.map(file => [file.wire.wire, file]));
		const plain = await Promise.all(results.map(async result => {
			const file = byWire.get(result.path);
			if (!file) throw new Error('Invalid initial upload results');
			// Hashes in a failure describe ciphertext, so only the outcome is passed on.
			if (!result.success) return { path: file.plain.path, success: false, error: result.error, code: result.code, status: result.status };
			if (result.hash !== file.wire.hash || typeof result.revision !== 'string' || !result.revision) throw new Error('Invalid initial upload metadata');
			this.wires.set(result.revision, { path: file.wire.wire, hash: file.wire.hash, size: file.wire.size });
			await encryption.paths.learn(file.plain.path, file.wire.wire);
			return { ...result, path: file.plain.path, hash: file.plain.hash };
		}));
		return { success: plain.every(result => result.success), results: plain };
	}

	private async send(token: string, files: PreparedUpload[]): Promise<BatchUploadResponse> {
		const first = files[0];
		if (files.length === 1 && first && first.size >= BATCH_FILE_SIZE_LIMIT) {
			return this.http.requestJson(`/sync/import/upload?path=${encodeURIComponent(first.path)}`, {
				method: 'PUT', headers: { [INITIAL_IMPORT_HEADER]: token, [FILE_HASH_HEADER]: first.hash,
					[EXPECTED_HASH_HEADER]: first.expectedHash ?? 'absent', 'Content-Type': first.contentType || 'application/octet-stream' },
				body: first.content,
			}, transferTimeout(first.content.byteLength));
		}
		const body = JSON.stringify({ files: files.map(file => ({ path: file.path, hash: file.hash, size: file.size,
			content: arrayBufferToBase64(file.content), contentType: file.contentType, expectedHash: file.expectedHash ?? null })) });
		return this.http.requestJson('/sync/import/upload', { method: 'POST', headers: { [INITIAL_IMPORT_HEADER]: token }, body }, transferTimeout(body.length));
	}

	/** The server copy a revision names. One this device did not upload is looked up in the
	 * server manifest, read at one snapshot. */
	private async wireOf(revision: string | undefined): Promise<WireFile | undefined> {
		if (!revision) return undefined;
		if (!this.wires.has(revision)) {
			// Lookups made together share one listing, so resuming a large import reads it once.
			this.listing ??= this.readRawManifest().then(({ files }) => {
				for (const [path, entry] of Object.entries(files)) if (entry.revision) this.wires.set(entry.revision, { path, hash: entry.hash, size: entry.size });
			}).finally(() => { this.listing = undefined; });
			await this.listing;
		}
		return this.wires.get(revision);
	}

	/** The server copy of each listed file, which an encrypted import names by revision. */
	private async serverFiles(files: Array<{ revision?: string }>): Promise<WireFile[]> {
		return Promise.all(files.map(async file => {
			const wire = await this.wireOf(file.revision);
			if (!wire) throw new Error('Initial upload changed. Sync again to resume.');
			return wire;
		}));
	}

	async prune(token: string, files: Array<{ path: string; hash: string; revision?: string }>): Promise<void> {
		const listed = this.encryption ? await this.serverFiles(files) : files;
		for (let offset = 0; offset < listed.length; offset += INITIAL_IMPORT_PRUNE_MAX_FILES) {
			const page = listed.slice(offset, offset + INITIAL_IMPORT_PRUNE_MAX_FILES).map(({ path, hash }) => ({ path, hash }));
			await this.http.requestJson('/sync/import/prune', { method: 'POST', body: JSON.stringify({ token, files: page }) });
		}
	}

	async finish(token: string, inventory: Record<string, ImportInventoryFile>): Promise<number> {
		let listed: Record<string, { hash: string; size: number }> = inventory;
		if (this.encryption) {
			listed = createPathRecord<{ hash: string; size: number }>();
			for (const wire of await this.serverFiles(Object.values(inventory))) listed[wire.path] = { hash: wire.hash, size: wire.size };
		}
		const pages = importInventoryPages(listed);
		let after = '', result: { lastSeq?: number; cursor?: string } = {};
		for (const [index, entries] of pages.entries()) {
			const final = index === pages.length - 1;
			result = await this.http.requestJson<{ lastSeq?: number; cursor?: string }>('/sync/import/complete', { method: 'POST', body: JSON.stringify({ token, after, entries, final }) });
			// A completed import (for example after a lost response) answers any page.
			if (result.lastSeq !== undefined) break;
			if (!final && typeof result.cursor !== 'string') throw new Error('Invalid initial import verification');
			after = result.cursor ?? after;
		}
		const lastSeq = result.lastSeq;
		if (lastSeq === undefined || !Number.isSafeInteger(lastSeq) || lastSeq < 1) throw new Error('Invalid initial import checkpoint');
		this.pendingSetup = { token, workerUrl: this.http.getWorkerUrl() };
		return lastSeq;
	}

	isPreparingReminders(): boolean { return this.pendingSetup?.workerUrl === this.http.getWorkerUrl(); }

	async finishReminderSetup(signal: AbortSignal, onProgress?: (progress: ReminderSetupProgress) => void): Promise<void> {
		if (this.pendingSetup && this.isPreparingReminders()) await this.waitUntilReady(this.pendingSetup.token, signal, onProgress);
	}

	async waitUntilReady(token: string, signal: AbortSignal, onProgress?: (progress: ReminderSetupProgress) => void): Promise<void> {
		const workerUrl = this.http.getWorkerUrl();
		// Bound a foreground wait; the durable marker survives a timeout, close or restart.
		const started = Date.now();
		const deadline = started + 3 * 60 * 60 * 1000;
		while (Date.now() < deadline) {
			signal.throwIfAborted();
			if (this.http.getWorkerUrl() !== workerUrl) throw new Error('Sync connection changed during reminder setup');
			const status = await this.http.requestJson<ReminderSetupStatus>('/sync/import/readiness', {
				method: 'POST', body: JSON.stringify({ token }),
			});
			signal.throwIfAborted();
			if (this.http.getWorkerUrl() !== workerUrl) throw new Error('Sync connection changed during reminder setup');
			if (status.ready === true) {
				this.establishedAt = workerUrl;
				if (this.pendingSetup?.token === token) this.pendingSetup = undefined;
				return;
			}
			if (status.ready !== false) throw new Error('Invalid reminder setup response');
			if (status.progress && typeof status.progress.scanning === 'boolean'
				&& Number.isSafeInteger(status.progress.remainingFiles) && status.progress.remainingFiles >= 0
				&& Number.isSafeInteger(status.progress.remainingSchedules) && status.progress.remainingSchedules >= 0) {
				onProgress?.(status.progress);
			}
			if (status.error) {
				const summary = `Files uploaded. Reminder setup needs attention: ${status.error}`;
				const issues = normalizeSyncIssues(status.issues, 20).map(issue => ({ ...issue, scope: 'reminders' as const }));
				if (status.moreIssues === true) issues.push({ scope: 'reminders', code: 'more-reminder-issues', message: 'More reminder notes need attention. Repair the listed notes, then sync again to review the remaining files.' });
				throw new SyncIssueError(summary, issues.length ? issues : [{ message: summary, scope: 'reminders' }]);
			}
			// Each poll counts the server's whole remaining setup work, so poll every second
			// for the first minute, then every 5 s, still noticing cancellation each second.
			const seconds = Date.now() - started < 60_000 ? 1 : 5;
			for (let waited = 0; waited < seconds; waited++) {
				if (waited) signal.throwIfAborted();
				await new Promise(resolve => setTimeout(resolve, 1000));
			}
		}
		throw new Error('Files uploaded. Reminder setup is still running; sync again to check completion.');
	}
}
