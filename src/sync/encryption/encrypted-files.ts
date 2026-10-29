import { FileKeyAuthority } from '../../encryption/file-authority';
import { openFile, openFileMetadata, sealFile, type PathBinding, type PrivateFileMetadata } from '../../encryption/file-codec';
import { ENCRYPTED_FILE_CONTENT_TYPE, validateFileDescriptor } from '../../encryption/file-format';
import type { VaultKeyBundle } from '../../encryption/key-bundle';
import { PathTags } from '../../encryption/path-tags';
import { resolveEncryptedPath, type ReadingFolderForms } from '../../encryption/path-binding';
import { arrayBufferToBase64, base64ToArrayBuffer } from '../encoding';
import type { EncryptedUploadWire, JournalUpload } from '../durability/upload-intent';
import { HttpError, type WorkerApiHttpClient } from '../worker-api/http';
import { parseFileMetadata } from '../worker-api/read-contracts';
import { decryptJson, encryptJson } from '../../encryption/envelope';
import { validateEncryptedSettings, type EncryptedSettings } from '../../encryption/settings-format';
import type { RestoreIntent } from '../durability/restore-intent';
import { parseFileVersions } from '../worker-api/version-contract';
import { BATCH_DOWNLOAD_MAX_FILES, ENCRYPTION_METADATA_BATCH } from '../../protocol/sync-limits';
import { sha256Hex } from '../../platform/sha256';
import { distinctLocalName, PathIndex, type SyncedFile } from './path-index';
import { portablePathKey } from '../../protocol/portable-path';

interface WireMetadata { hash: string; size: number; revision?: string }
const METADATA_CONCURRENCY = 4;
// Reuse across the overlapping requests of one large inventory.
const MAX_VERIFIED_METADATA = ENCRYPTION_METADATA_BATCH * METADATA_CONCURRENCY;
type PublicDataBuilder = (path: string, content: ArrayBuffer) => Promise<unknown>;
interface VerifiedRevision { metadata: PrivateFileMetadata; wireHash: string; wire: string }
/** A plaintext precondition to translate into the server's ciphertext hash. */
export interface ExpectedHashRequest { path: string; expected: string | null; revision?: string | null }
/** One upload batch's resolved preconditions, each consumed once by `prepare`. */
export type UploadPreconditions = Map<string, { expected: string | null; result: string | null | HttpError }>;
/** A verified file listed at server path `wire`: its plaintext path, and the entry with plaintext hash and size. */
export interface PlainEntry<T> { path: string; wire: string; entry: T }

function conflictError(): HttpError {
	return new HttpError('Remote file changed; sync again before writing', 409, null, 'version_conflict');
}

function namespaceConflict(path: string, existing: string): HttpError {
	return new HttpError(`${path} conflicts with ${existing}, which differs only in letter case or Unicode form`, 409, null, 'namespace_conflict');
}

/** A note the server sealed that would replace or take the name of a file this device
 * holds. `path` is where sync lists it: the file it would replace, or a distinct name. */
class SealedReplacementError extends Error {
	constructor(readonly path: string, readonly hash: string) {
		super('The server created a note that would replace one already synced here. It was not applied, and the local copy is unchanged.');
	}
}

/** Boundary between ciphertext transport identities and local sync identities.
 * The server stores files under tagged paths; callers use plaintext paths.
 * Never substitute a decrypted hash into an R2 or conditional-write request. */
export class EncryptedFiles {
	private readonly verifiedMetadata = new Map<string, VerifiedRevision>();
	// Wires sealed by this instance from content whose hash and size it checked.
	// Journal entries loaded from disk are new objects and get full verification.
	private readonly sealed = new WeakSet<EncryptedUploadWire>();
	private constructor(private readonly http: WorkerApiHttpClient, readonly keys: FileKeyAuthority,
		readonly generation: number, private readonly publicData: PublicDataBuilder, readonly paths: PathIndex,
		private readonly readingFolder: () => string | null) {}

	/** `readingFolder` is where notes the server sealed to the vault are accepted. */
	static async create(http: WorkerApiHttpClient, bundle: VaultKeyBundle, publicData: PublicDataBuilder, readingFolder: () => string | null = () => null): Promise<EncryptedFiles> {
		return new EncryptedFiles(http, await FileKeyAuthority.fromBundle(bundle), bundle.generation, publicData,
			new PathIndex(await PathTags.fromSecret(bundle.vaultId, bundle.vault)), readingFolder);
	}

	private async reading(): Promise<ReadingFolderForms | null> {
		const plain = this.readingFolder();
		return plain ? { plain, wire: await this.paths.tags.wire(plain) } : null;
	}

	/** Checks a file's claimed path against its server path. Live files also teach the
	 * index where they are stored; retained versions must not. `synced` shares one read
	 * of the Reading folder's synced files across a listing. */
	private binding(wire: string, live: boolean, synced?: (folder: string) => Promise<SyncedFile[]>): PathBinding {
		return async (metadataPath, sealed, hash) => {
			const reading = await this.reading();
			const path = await resolveEncryptedPath(this.paths.tags, wire, metadataPath, sealed, reading);
			if (sealed && live && reading) {
				await this.acceptSealed(path, wire, hash, await (synced ? synced(reading.plain) : this.paths.syncedIn(reading.plain)));
			}
			if (live) await this.paths.learn(path, wire);
			return path;
		};
	}

	/** The server may only create sealed notes. One is accepted at a server path this
	 * device already holds only with the bytes it holds, and never under the name of a
	 * note stored at another server path. This includes an untouched Shortcut note. */
	private async acceptSealed(path: string, wire: string, hash: string, synced: SyncedFile[]): Promise<void> {
		const held = synced.find(file => file.wire === wire);
		if (held) {
			if (held.path === path && held.hash === hash) return;
			throw new SealedReplacementError(held.path, hash);
		}
		const key = portablePathKey(path);
		if (synced.some(file => portablePathKey(file.path) === key)) {
			throw new SealedReplacementError(distinctLocalName(path, wire), hash);
		}
	}

	/** Open the metadata of files listed by server path, returning their plaintext paths. */
	async metadata<T extends WireMetadata>(entries: Array<{ path: string; entry: T }>, live = true): Promise<Array<PlainEntry<T>>> {
		// Bound both unverified descriptors and retained metadata during large
		// inventories, while a few requests overlap their round trips.
		const chunks: Array<Array<{ path: string; entry: T }>> = [];
		for (let offset = 0; offset < entries.length; offset += ENCRYPTION_METADATA_BATCH) chunks.push(entries.slice(offset, offset + ENCRYPTION_METADATA_BATCH));
		const results: Array<Array<PlainEntry<T>>> = [];
		let synced: Promise<SyncedFile[]> | undefined;
		const syncedOnce = (folder: string) => synced ??= this.paths.syncedIn(folder);
		for (let start = 0; start < chunks.length; start += METADATA_CONCURRENCY) {
			const group = await Promise.all(chunks.slice(start, start + METADATA_CONCURRENCY).map(chunk => this.metadataChunk(chunk, live, syncedOnce)));
			results.push(...group);
		}
		return results.flat();
	}

	private async metadataChunk<T extends WireMetadata>(chunk: Array<{ path: string; entry: T }>, live: boolean,
		synced: (folder: string) => Promise<SyncedFile[]>): Promise<Array<PlainEntry<T>>> {
		const result: Array<PlainEntry<T>> = [];
		const cached = new Map<string, VerifiedRevision>();
		const missing = new Set<string>();
		for (const { entry } of chunk) {
			if (!entry.revision) throw new Error('Encrypted file metadata is missing its immutable revision');
			const verified = this.verifiedMetadata.get(entry.revision);
			if (verified) cached.set(entry.revision, verified); else missing.add(entry.revision);
		}
		const response = missing.size ? await this.http.requestJson<{ descriptors: Record<string, unknown> }>('/encryption/metadata', {
			method: 'POST', body: JSON.stringify({ revisions: [...missing] }),
		}) : null;
		// The small snapshot remains usable if concurrent reads evict entries.
		for (const { path, entry } of chunk) {
			let verified = cached.get(entry.revision!);
			if (!verified) {
				const descriptor = response?.descriptors?.[entry.revision!];
				validateFileDescriptor(descriptor);
				let metadata: PrivateFileMetadata;
				try { metadata = await openFileMetadata(descriptor, this.binding(path, live, synced), this.keys.forPath(path)); }
				catch (error) {
					// Listed but never cached or learned, so sync reports it without applying it.
					if (!(error instanceof SealedReplacementError)) throw error;
					result.push({ path: error.path, wire: path, entry: { ...entry, hash: error.hash, rejected: true } });
					continue;
				}
				verified = { metadata, wireHash: entry.hash, wire: path };
				cached.set(entry.revision!, verified);
				this.verifiedMetadata.set(entry.revision!, verified);
				while (this.verifiedMetadata.size > MAX_VERIFIED_METADATA) this.verifiedMetadata.delete(this.verifiedMetadata.keys().next().value!);
			}
			// A revision opened at one server path names the same file under no other.
			if (verified.wire !== path) throw new Error('Encrypted file metadata does not match the requested file');
			result.push({ path: verified.metadata.path, wire: path, entry: { ...entry, hash: verified.metadata.hash, size: verified.metadata.size } });
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
		const results = await this.resolveExpected(requests);
		requests.forEach((request, index) => preloaded.set(request.path, { expected: request.expected, result: results[index]! }));
		return preloaded;
	}

	/** New files are checked too: names that differ only in case share one server path,
	 * so the server can no longer report that namespace conflict itself. */
	private async resolveExpected(requests: ExpectedHashRequest[]): Promise<Array<string | null | HttpError>> {
		const results = new Array<string | null | HttpError>(requests.length);
		const remote: number[] = [];
		for (const [index, request] of requests.entries()) {
			const verified = request.revision ? this.verifiedMetadata.get(request.revision) : undefined;
			// A verified revision names exact ciphertext, and the server still checks
			// hash and revision together at commit, so no preflight is needed.
			if (request.expected !== null && verified && verified.metadata.path === request.path && verified.metadata.hash === request.expected) results[index] = verified.wireHash;
			else remote.push(index);
		}
		for (let offset = 0; offset < remote.length; offset += BATCH_DOWNLOAD_MAX_FILES) {
			const chunk = remote.slice(offset, offset + BATCH_DOWNLOAD_MAX_FILES);
			const wires = await Promise.all(chunk.map(index => this.paths.wireFor(requests[index]!.path)));
			const files = parseFileMetadata(await this.http.requestJson('/sync/metadata', {
				method: 'POST', body: JSON.stringify({ paths: [...new Set(wires)] }),
			}), wires).files;
			const present = wires.filter(wire => files[wire]);
			const opened = new Map((await this.metadata(present.map(wire => ({ path: wire, entry: files[wire]! })))).map(item => [item.wire, item]));
			for (const [position, index] of chunk.entries()) {
				const { path, expected, revision } = requests[index]!;
				const wire = wires[position]!, raw = files[wire], current = opened.get(wire);
				if (!raw || !current) results[index] = expected === null ? null : await this.absentExpectedHash(path, wire, expected, revision);
				else if (current.path !== path) results[index] = expected === null ? namespaceConflict(path, current.path) : conflictError();
				else results[index] = expected === null || current.entry.hash !== expected || (revision && raw.revision !== revision) ? conflictError() : raw.hash;
			}
		}
		return results;
	}

	private async absentExpectedHash(path: string, wire: string, expected: string, revision?: string | null): Promise<string | HttpError> {
		if (revision) {
			const result = await this.http.requestJson<{ receipt: { hash: string } | null }>(`/encryption/deletion-precondition?${new URLSearchParams({ path: wire, revision })}`);
			if (result.receipt) {
				const [plain] = await this.metadata([{ path: wire, entry: { hash: result.receipt.hash, size: 0, revision } }], false);
				if (plain?.path === path && plain.entry.hash === expected) return result.receipt.hash;
			}
		}
		return conflictError();
	}

	async prepare(file: JournalUpload, batch?: UploadPreconditions): Promise<EncryptedUploadWire> {
		const preloaded = batch?.get(file.path);
		if (preloaded) batch!.delete(file.path);
		const resolved = preloaded && preloaded.expected === file.expectedHash ? preloaded.result : undefined;
		if (resolved instanceof HttpError) throw resolved;
		const expectedHash = resolved !== undefined ? resolved : await this.expectedHash(file.path, file.expectedHash);
		const path = await this.paths.wireFor(file.path);
		const content = base64ToArrayBuffer(file.content);
		const sealed = await sealFile({ path: file.path, content: new Uint8Array(content), contentType: file.contentType,
			publicData: await this.publicData(file.path, content) }, this.keys.forPath(path));
		if (sealed.metadata.hash !== file.hash || sealed.metadata.size !== file.size) throw new Error('File changed before encryption');
		const wire: EncryptedUploadWire = { format: 'crate-e2ee-v1', generation: this.generation, path, content: arrayBufferToBase64(sealed.bytes.buffer),
			hash: sealed.hash, size: sealed.bytes.byteLength, contentType: ENCRYPTED_FILE_CONTENT_TYPE, expectedHash };
		this.sealed.add(wire);
		return wire;
	}

	async verifyPrepared(file: JournalUpload): Promise<void> {
		if (!file.encryptedWire) throw new Error('A plaintext upload is unresolved. Recover it before enabling encryption.');
		if (this.sealed.has(file.encryptedWire)) return;
		const plain = await this.download(file.encryptedWire.path, base64ToArrayBuffer(file.encryptedWire.content), file.encryptedWire, file.path);
		if (plain.metadata.hash !== file.hash || plain.metadata.size !== file.size) throw new Error('Encrypted upload does not match its saved local content');
	}

	/** Open a file downloaded from server path `wire`. With `expected`, it must be the
	 * file this device knows by that plaintext path. */
	async download(wire: string, bytes: ArrayBuffer, check?: Pick<WireMetadata, 'hash' | 'size'>, expected?: string, live = true): Promise<{ content: ArrayBuffer; metadata: PrivateFileMetadata }> {
		if (check && (bytes.byteLength !== check.size || await sha256Hex(bytes) !== check.hash)) throw new Error('Encrypted transfer failed integrity validation');
		const opened = await openFile(new Uint8Array(bytes), this.binding(wire, live), this.keys.forPath(wire));
		if (expected !== undefined && opened.metadata.path !== expected && await this.paths.plainFor(wire) !== expected) {
			throw new Error('Encrypted file metadata does not match the requested file');
		}
		return { content: opened.content.buffer, metadata: { ...opened.metadata, path: expected ?? opened.metadata.path } };
	}

	async sealSettings(settings: unknown): Promise<EncryptedSettings> {
		const authority = this.keys.forVaultMetadata();
		return { version: 1, vaultId: authority.vaultId, keyId: authority.key.id, envelope: await encryptJson(settings, authority.key,
			{ vaultId: authority.vaultId, scopeId: authority.scopeId, objectId: 'shared-settings', purpose: 'settings' }) };
	}
	async prepareRestore(intent: RestoreIntent): Promise<NonNullable<RestoreIntent['encryptedWire']>> {
		let cursor: string | undefined;
		const seen = new Set<string>();
		const wire = intent.version.wire ?? await this.paths.wireFor(intent.version.path);
		while (true) {
			const query = new URLSearchParams({ path: wire });
			if (cursor) query.set('cursor', cursor);
			const page = parseFileVersions(await this.http.requestJson(`/sync/versions?${query}`));
			const raw = page.versions.find(version => version.storage_key === intent.version.storage_key);
			if (raw) {
				const [plain] = await this.metadata([{ path: raw.path, entry: { ...raw, revision: raw.storage_key } }], false);
				if (plain!.path !== intent.version.path || plain!.entry.hash !== intent.version.hash || plain!.entry.size !== intent.version.size) {
					throw new Error('Retained encrypted version does not match the requested restore');
				}
				return { vaultId: this.keys.vaultId, generation: this.generation, path: wire, restoredHash: raw.hash,
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
