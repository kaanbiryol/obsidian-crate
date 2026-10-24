import type { FileKeyAuthority } from '../../encryption/file-authority';
import { openFile, sealFile } from '../../encryption/file-codec';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '../../encryption/file-format';
import { encryptJson } from '../../encryption/envelope';
import type { EncryptedSchedules } from '../../encryption/notification-format';
import { sha256Hex } from '../../platform/sha256';

export interface ConversionFile { path: string; revision: string; hash: string; size: number }
export interface ConversionReceipt { operation_id: string; request_hash: string; response_json: string }
type Projection = (path: string, bytes: ArrayBuffer) => Promise<EncryptedSchedules | null>;

/** Authenticate originals and interrupted replacements before preparing any write. */
export async function prepareConversionFile(file: ConversionFile, body: ArrayBuffer, contentType: string | null, keys: FileKeyAuthority, project: Projection) {
	// Original metadata is authoritative even if plaintext resembles our wire format.
	const original = body.byteLength === file.size && await sha256Hex(body) === file.hash;
	if (!original) {
		if (contentType !== ENCRYPTED_FILE_CONTENT_TYPE) throw new Error('The original file failed integrity validation. Conversion remains paused.');
		const opened = await openFile(new Uint8Array(body), file.path, keys.forPath(file.path));
		if (opened.metadata.hash !== file.hash || opened.metadata.size !== file.size) throw new Error('Interrupted conversion does not match the original file');
		return { bytes: new Uint8Array(body), plainHash: opened.metadata.hash };
	}
	const sealed = await sealFile({ path: file.path, content: new Uint8Array(body), contentType: contentType ?? 'application/octet-stream', publicData: await project(file.path, body) }, keys.forPath(file.path));
	return { bytes: sealed.bytes, plainHash: sealed.metadata.hash };
}

/** Encrypt a pre-encryption receipt with the vault key so a lost response can still be replayed. */
export async function prepareConversionReceipt(receipt: ConversionReceipt, kind: 'reminder' | 'reading' | 'upload', keys: FileKeyAuthority) {
	const response: unknown = JSON.parse(receipt.response_json);
	const value = { ...(kind === 'upload' ? { kind } : {}), requestHash: receipt.request_hash, response };
	const context = { vaultId: keys.vaultId, scopeId: 'vault', objectId: receipt.operation_id, purpose: 'reminder' as const };
	return { ...(kind === 'reminder' ? {} : { kind }), operationId: receipt.operation_id,
		vault: await encryptJson(value, keys.forVaultMetadata().key, context) };
}
