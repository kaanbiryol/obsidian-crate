import { FileKeyAuthority } from '../encryption/file-authority';
import { openFile, openFileMetadata, sealFile, type PrivateFileMetadata } from '../encryption/file-codec';
import { ENCRYPTED_FILE_CONTENT_TYPE, validateFileDescriptor } from '../encryption/file-format';
import type { VaultKeyBundle } from '../encryption/key-bundle';
import { arrayBufferToBase64, base64ToArrayBuffer } from './encoding';
import { computeHash } from './hasher';
import type { EncryptedUploadWire, JournalUpload } from './upload-intent';
import { HttpError, type WorkerApiHttpClient } from './worker-api/http';
import { parseFileMetadata } from './worker-api/read-contracts';
import { decryptJson, encryptJson } from '../encryption/envelope';
import { validateEncryptedSettings, type EncryptedSettings } from '../encryption/settings-format';
import type { RestoreIntent } from './restore-intent';
import { parseFileVersions } from './worker-api/version-contract';
import type { UploadResult } from '../protocol/sync-types';
import { BATCH_DOWNLOAD_MAX_FILES, ENCRYPTION_METADATA_BATCH } from '../protocol/sync-limits';

interface WireMetadata { hash: string; size: number; revision?: string }
const METADATA_CONCURRENCY = 4;
// Reuse across the overlapping requests of one large inventory.
const MAX_VERIFIED_METADATA = ENCRYPTION_METADATA_BATCH * METADATA_CONCURRENCY;
type PublicDataBuilder = (path: string, content: ArrayBuffer) => Promise<unknown>;
interface VerifiedRevision { metadata: PrivateFileMetadata; wireHash: string }
/** A plaintext precondition to translate into the server's ciphertext hash. */
export interface ExpectedHashRequest { path: string; expected: string | null; revision?: string | null }
/** One upload batch's resolved preconditions, each consumed once by `prepare`. */
export type UploadPreconditions = Map<string, { expected: string; result: string | HttpError }>;

function conflictError(): HttpError {
	return new HttpError('Remote file changed; sync again before writing', 409, null, 'version_conflict');
}

/** Boundary between ciphertext transport identities and local sync identities.
 * Never substitute a decrypted hash into an R2 or conditional-write request. */
export class EncryptedFiles {
	private readonly verifiedMetadata = new Map<string, VerifiedRevision>();
	// Wires sealed by this instance from content whose hash and size it checked.
	// Journal entries loaded from disk are new objects and get full verification.
	private readonly sealed = new WeakSet<EncryptedUploadWire>();
	private constructor(private readonly http: WorkerApiHttpClient, readonly keys: FileKeyAuthority,
		readonly generation: number, private readonly publicData: PublicDataBuilder) {}

	static async create(http: WorkerApiHttpClient, bundle: VaultKeyBundle, publicData: PublicDataBuilder): Promise<EncryptedFiles> {
		return new EncryptedFiles(http, await FileKeyAuthority.fromVault(bundle), bundle.generation, publicData);
	}

	async metadata<T extends WireMetadata>(entries: Array<{ path: string; entry: T }>): Promise<T[]> {
		// Bound both unverified descriptors and retained metadata during large
		// inventories, while a few requests overlap their round trips.
		const chunks: Array<Array<{ path: string; entry: T }>> = [];
		for (let offset = 0; offset < entries.length; offset += ENCRYPTION_METADATA_BATCH) chunks.push(entries.slice(offset, offset + ENCRYPTION_METADATA_BATCH));
		const results: T[][] = [];
		for (let start = 0; start < chunks.length; start += METADATA_CONCURRENCY) {
			const group = await Promise.all(chunks.slice(start, start + METADATA_CONCURRENCY).map(chunk => this.metadataChunk(chunk)));
			results.push(...group);
		}
		return results.flat();
	}

	private async metadataChunk<T extends WireMetadata>(chunk: Array<{ path: string; entry: T }>): Promise<T[]> {
		const result: T[] = [];
		const cached = new Map<string, PrivateFileMetadata>();
		const missing = new Set<string>();
		for (const { entry } of chunk) {
			if (!entry.revision) throw new Error('Encrypted file metadata is missing its immutable revision');
			const verified = this.verifiedMetadata.get(entry.revision);
			if (verified) cached.set(entry.revision, verified.metadata); else missing.add(entry.revision);
		}
		const response = missing.size ? await this.http.requestJson<{ descriptors: Record<string, unknown> }>('/encryption/metadata', {
			method: 'POST', body: JSON.stringify({ revisions: [...missing] }),
		}) : null;
		// The small snapshot remains usable if concurrent reads evict entries.
		for (const { path, entry } of chunk) {
			let metadata = cached.get(entry.revision!);
			if (!metadata) {
				const descriptor = response?.descriptors?.[entry.revision!];
				validateFileDescriptor(descriptor);
				metadata = await openFileMetadata(descriptor, path, this.keys.forPath(path));
				cached.set(entry.revision!, metadata);
				this.verifiedMetadata.set(entry.revision!, { metadata, wireHash: entry.hash });
				while (this.verifiedMetadata.size > MAX_VERIFIED_METADATA) this.verifiedMetadata.delete(this.verifiedMetadata.keys().next().value!);
			}
			if (metadata.path !== path) throw new Error('Encrypted file metadata does not match the requested file');
			result.push({ ...entry, hash: metadata.hash, size: metadata.size });
		}
		return result;
	}

	async expectedHash(path: string, expected: string | null, revision?: string | null): Promise<string | null> {
		return (await this.expectedHashes([{ path, expected, revision }]))[0]!;
	}

	/** Ciphertext preconditions for several files, throwing on the first conflict. */
	async expectedHashes(requests: ExpectedHashRequest[]): Promise<Array<string | null>> {
		const results = await this.resolveExpected(requests);
		const conflict = results.find(result => result instanceof HttpError);
		if (conflict) throw conflict;
		return results as Array<string | null>;
	}

	/** Resolve one upload batch's preconditions together. The result is scoped to
	 * that batch, so concurrent batches cannot consume or discard each other's. */
	async preloadExpected(requests: ExpectedHashRequest[]): Promise<UploadPreconditions> {
		const preloaded: UploadPreconditions = new Map();
		const pending = requests.filter(request => request.expected !== null);
		const results = await this.resolveExpected(pending);
		pending.forEach((request, index) => preloaded.set(request.path, { expected: request.expected!, result: results[index]! }));
		return preloaded;
	}

	private async resolveExpected(requests: ExpectedHashRequest[]): Promise<Array<string | null | HttpError>> {
		const results = new Array<string | null | HttpError>(requests.length);
		const remote: number[] = [];
		for (const [index, request] of requests.entries()) {
			if (request.expected === null) { results[index] = null; continue; }
			const verified = request.revision ? this.verifiedMetadata.get(request.revision) : undefined;
			// A verified revision names exact ciphertext, and the server still checks
			// hash and revision together at commit, so no preflight is needed.
			if (verified && verified.metadata.path === request.path && verified.metadata.hash === request.expected) results[index] = verified.wireHash;
			else remote.push(index);
		}
		for (let offset = 0; offset < remote.length; offset += BATCH_DOWNLOAD_MAX_FILES) {
			const chunk = remote.slice(offset, offset + BATCH_DOWNLOAD_MAX_FILES);
			const paths = chunk.map(index => requests[index]!.path);
			const files = parseFileMetadata(await this.http.requestJson('/sync/metadata', {
				method: 'POST', body: JSON.stringify({ paths }),
			}), paths).files;
			const present = chunk.filter(index => files[requests[index]!.path]);
			const plain = await this.metadata(present.map(index => ({ path: requests[index]!.path, entry: files[requests[index]!.path]! })));
			const plainByIndex = new Map(present.map((index, position) => [index, plain[position]!]));
			for (const index of chunk) {
				const { path, expected, revision } = requests[index]!;
				const raw = files[path];
				if (!raw) { results[index] = await this.absentExpectedHash(path, expected!, revision); continue; }
				results[index] = plainByIndex.get(index)?.hash !== expected || (revision && raw.revision !== revision) ? conflictError() : raw.hash;
			}
		}
		return results;
	}

	private async absentExpectedHash(path: string, expected: string, revision?: string | null): Promise<string | HttpError> {
		if (revision) {
			const result = await this.http.requestJson<{ receipt: { hash: string } | null }>(`/encryption/deletion-precondition?${new URLSearchParams({ path, revision })}`);
			if (result.receipt) {
				const [plain] = await this.metadata([{ path, entry: { hash: result.receipt.hash, size: 0, revision } }]);
				if (plain?.hash === expected) return result.receipt.hash;
			}
		}
		return conflictError();
	}

	async prepare(file: JournalUpload, batch?: UploadPreconditions): Promise<EncryptedUploadWire> {
		const preloaded = batch?.get(file.path);
		if (preloaded) batch!.delete(file.path);
		const resolved = preloaded && preloaded.expected === file.expectedHash ? preloaded.result : undefined;
		if (resolved instanceof HttpError) throw resolved;
		const expectedHash = resolved ?? await this.expectedHash(file.path, file.expectedHash);
		const content = base64ToArrayBuffer(file.content);
		const sealed = await sealFile({ path: file.path, content: new Uint8Array(content), contentType: file.contentType,
			publicData: await this.publicData(file.path, content) }, this.keys.forPath(file.path));
		if (sealed.metadata.hash !== file.hash || sealed.metadata.size !== file.size) throw new Error('File changed before encryption');
		const wire: EncryptedUploadWire = { format: 'crate-e2ee-v1', generation: this.generation, content: arrayBufferToBase64(sealed.bytes.buffer), hash: sealed.hash,
			size: sealed.bytes.byteLength, contentType: ENCRYPTED_FILE_CONTENT_TYPE, expectedHash };
		this.sealed.add(wire);
		return wire;
	}

	async verifyPrepared(file: JournalUpload): Promise<void> {
		if (!file.encryptedWire) throw new Error('A plaintext upload is unresolved. Recover it before enabling encryption.');
		if (this.sealed.has(file.encryptedWire)) return;
		const plain = await this.download(file.path, base64ToArrayBuffer(file.encryptedWire.content), file.encryptedWire);
		if (plain.metadata.hash !== file.hash || plain.metadata.size !== file.size) throw new Error('Encrypted upload does not match its saved local content');
	}
	async resolveLegacyOperation(operationId: string, payload: Record<string, unknown>): Promise<UploadResult> {
		const saved = await this.http.requestJson<{ envelope: string | null; retryValid: boolean }>(`/encryption/upload-receipt?operationId=${encodeURIComponent(operationId)}`);
		if (!saved.envelope) {
			if (!saved.retryValid) throw new Error('This old upload is outside its retry window. Preserve local files and compare the server before resetting sync.');
			// No receipt existed when plaintext publication was permanently fenced.
			// Reconciliation can prepare a fresh encrypted operation from local data.
			return { success: false, path: String(payload.path), status: 409, code: 'version_conflict', error: 'Encryption was enabled before this upload committed. Reconcile before preparing an encrypted upload.' };
		}
		const authority = this.keys.forVaultMetadata();
		const receipt = await decryptJson(saved.envelope, authority.key, { vaultId: authority.vaultId, scopeId: 'vault', objectId: operationId, purpose: 'reminder' }) as { kind: string; requestHash: string; response: UploadResult };
		if (receipt.kind !== 'upload' || receipt.requestHash !== await computeHash(new TextEncoder().encode(JSON.stringify(payload)).buffer)) throw new Error('The encrypted legacy receipt does not match the saved operation');
		return receipt.response;
	}

	async download(path: string, bytes: ArrayBuffer, wire?: Pick<WireMetadata, 'hash' | 'size'>): Promise<{ content: ArrayBuffer; metadata: PrivateFileMetadata }> {
		if (wire && (bytes.byteLength !== wire.size || await computeHash(bytes) !== wire.hash)) throw new Error('Encrypted transfer failed integrity validation');
		const opened = await openFile(new Uint8Array(bytes), path, this.keys.forPath(path));
		return { content: opened.content.buffer, metadata: opened.metadata };
	}

	async sealSettings(settings: unknown): Promise<EncryptedSettings> {
		const authority = this.keys.forVaultMetadata();
		return { version: 1, vaultId: authority.vaultId, keyId: authority.key.id, envelope: await encryptJson(settings, authority.key,
			{ vaultId: authority.vaultId, scopeId: authority.scopeId, objectId: 'shared-settings', purpose: 'settings' }) };
	}
	async openCheckpoint(envelope: string, id: string): Promise<unknown> {
		const authority = this.keys.forVaultMetadata();
		return decryptJson(envelope, authority.key, { vaultId: authority.vaultId, scopeId: authority.scopeId, objectId: id, purpose: 'settings' });
	}
	async prepareRestore(intent: RestoreIntent): Promise<NonNullable<RestoreIntent['encryptedWire']>> {
		let cursor: string | undefined;
		const seen = new Set<string>();
		while (true) {
			const query = new URLSearchParams({ path: intent.version.path });
			if (cursor) query.set('cursor', cursor);
			const page = parseFileVersions(await this.http.requestJson(`/sync/versions?${query}`));
			const raw = page.versions.find(version => version.storage_key === intent.version.storage_key);
			if (raw) {
				const [plain] = await this.metadata([{ path: raw.path, entry: { ...raw, revision: raw.storage_key } }]);
				if (plain!.hash !== intent.version.hash || plain!.size !== intent.version.size) throw new Error('Retained encrypted version does not match the requested restore');
				return { vaultId: this.keys.vaultId, generation: this.generation, restoredHash: raw.hash,
					expectedHash: await this.expectedHash(intent.request.path, intent.request.expectedHash, intent.request.expectedRevision) };
			}
			if (!page.hasMore) throw new Error('Retained encrypted file is no longer available');
			if (!page.nextCursor || seen.has(page.nextCursor)) throw new Error('Retained-file pagination did not advance');
			cursor = page.nextCursor;
			seen.add(cursor);
		}
	}
	async openSettings(settings: unknown): Promise<unknown> {
		validateEncryptedSettings(settings);
		const authority = this.keys.forVaultMetadata();
		if (settings.vaultId !== authority.vaultId || settings.keyId !== authority.key.id) throw new Error('Settings belong to another encrypted vault');
		return decryptJson(settings.envelope, authority.key,
			{ vaultId: authority.vaultId, scopeId: authority.scopeId, objectId: 'shared-settings', purpose: 'settings' });
	}
}
