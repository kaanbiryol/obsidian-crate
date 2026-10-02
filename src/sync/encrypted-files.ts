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

interface WireMetadata { hash: string; size: number; revision?: string }
type PublicDataBuilder = (path: string, content: ArrayBuffer) => Promise<unknown>;

/** Boundary between ciphertext transport identities and local sync identities.
 * Never substitute a decrypted hash into an R2 or conditional-write request. */
export class EncryptedFiles {
	private readonly verifiedMetadata = new Map<string, PrivateFileMetadata>();
	private constructor(private readonly http: WorkerApiHttpClient, readonly keys: FileKeyAuthority,
		readonly generation: number, private readonly publicData: PublicDataBuilder) {}

	static async create(http: WorkerApiHttpClient, bundle: VaultKeyBundle, publicData: PublicDataBuilder): Promise<EncryptedFiles> {
		return new EncryptedFiles(http, await FileKeyAuthority.fromVault(bundle), bundle.generation, publicData);
	}

	async metadata<T extends WireMetadata>(entries: Array<{ path: string; entry: T }>): Promise<T[]> {
		const result: T[] = [];
		// Bound both unverified descriptors and retained metadata during large
		// inventories, not only after the entire vault has been processed.
		for (let offset = 0; offset < entries.length; offset += 100) {
			const chunk = entries.slice(offset, offset + 100);
			const cached = new Map<string, PrivateFileMetadata>();
			const missing = new Set<string>();
			for (const { entry } of chunk) {
				if (!entry.revision) throw new Error('Encrypted file metadata is missing its immutable revision');
				const metadata = this.verifiedMetadata.get(entry.revision);
				if (metadata) cached.set(entry.revision, metadata); else missing.add(entry.revision);
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
					this.verifiedMetadata.set(entry.revision!, metadata);
					while (this.verifiedMetadata.size > 5000) this.verifiedMetadata.delete(this.verifiedMetadata.keys().next().value!);
				}
				if (metadata.path !== path) throw new Error('Encrypted file metadata does not match the requested file');
				result.push({ ...entry, hash: metadata.hash, size: metadata.size });
			}
		}
		return result;
	}

	async expectedHash(path: string, expected: string | null, revision?: string | null): Promise<string | null> {
		if (expected === null) return null;
		const raw = parseFileMetadata(await this.http.requestJson('/sync/metadata', {
			method: 'POST', body: JSON.stringify({ paths: [path] }),
		}), [path]).files[path];
		if (!raw) {
			if (revision) {
				const result = await this.http.requestJson<{ receipt: { hash: string } | null }>(`/encryption/deletion-precondition?${new URLSearchParams({ path, revision })}`);
				if (result.receipt) {
					const [plain] = await this.metadata([{ path, entry: { hash: result.receipt.hash, size: 0, revision } }]);
					if (plain?.hash === expected) return result.receipt.hash;
				}
			}
			throw new HttpError('Remote file changed; sync again before writing', 409, null, 'version_conflict');
		}
		const [plain] = await this.metadata([{ path, entry: raw }]);
		if (plain?.hash !== expected || (revision && raw.revision !== revision)) {
			throw new HttpError('Remote file changed; sync again before writing', 409, null, 'version_conflict');
		}
		return raw.hash;
	}

	async prepare(file: JournalUpload): Promise<EncryptedUploadWire> {
		const expectedHash = await this.expectedHash(file.path, file.expectedHash);
		const content = base64ToArrayBuffer(file.content);
		const sealed = await sealFile({ path: file.path, content: new Uint8Array(content), contentType: file.contentType,
			publicData: await this.publicData(file.path, content) }, this.keys.forPath(file.path));
		if (sealed.metadata.hash !== file.hash || sealed.metadata.size !== file.size) throw new Error('File changed before encryption');
		return { format: 'crate-e2ee-v1', generation: this.generation, content: arrayBufferToBase64(sealed.bytes.buffer), hash: sealed.hash,
			size: sealed.bytes.byteLength, contentType: ENCRYPTED_FILE_CONTENT_TYPE, expectedHash };
	}

	async verifyPrepared(file: JournalUpload): Promise<void> {
		if (!file.encryptedWire) throw new Error('A plaintext upload is unresolved. Recover it before enabling encryption.');
		const plain = await this.download(file.path, base64ToArrayBuffer(file.encryptedWire.content), file.encryptedWire);
		if (plain.metadata.hash !== file.hash || plain.metadata.size !== file.size) throw new Error('Encrypted upload does not match its saved local content');
	}
	async resolveLegacyOperation(operationId: string, payload: Record<string, unknown>, retryMissing: true): Promise<UploadResult | null>;
	async resolveLegacyOperation(operationId: string, payload: Record<string, unknown>, retryMissing?: false): Promise<UploadResult>;
	async resolveLegacyOperation(operationId: string, payload: Record<string, unknown>, retryMissing = false): Promise<UploadResult | null> {
		const saved = await this.http.requestJson<{ envelope: string | null; retryValid: boolean }>(`/encryption/upload-receipt?operationId=${encodeURIComponent(operationId)}`);
		if (!saved.envelope) {
			if (!saved.retryValid) throw new Error('This old upload is outside its retry window. Preserve local files and compare the server before resetting sync.');
			if (retryMissing) return null;
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
