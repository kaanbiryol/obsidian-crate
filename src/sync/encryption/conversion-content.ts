import type { FileKeyAuthority } from '../../encryption/file-authority';
import { openFile, openFileMetadata, sealFile } from '../../encryption/file-codec';
import { ENCRYPTED_FILE_CONTENT_TYPE, type EncryptedFileDescriptor } from '../../encryption/file-format';
import { encryptJson } from '../../encryption/envelope';
import { createReminderProjection } from '../../encryption/reminder-projection';
import type { VaultKeyBundle } from '../../encryption/key-bundle';
import { sha256Hex } from '../../platform/sha256';

export interface ConversionFile { path: string; revision: string; hash: string; size: number; previous_descriptor?: string | null }
export interface ConversionReceipt { operation_id: string; request_hash: string; response_json: string }

/** Authenticate originals and interrupted replacements before preparing any write. */
export async function prepareConversionFile(file: ConversionFile, body: ArrayBuffer, contentType: string | null, bundle: VaultKeyBundle, keys: FileKeyAuthority) {
	let bytes: Uint8Array<ArrayBuffer>;
	let plainHash: string;
	// Original metadata is authoritative even if plaintext resembles our wire format.
	const original = body.byteLength === file.size && await sha256Hex(body) === file.hash;
	if (file.previous_descriptor) {
		const previousDescriptor = JSON.parse(file.previous_descriptor) as EncryptedFileDescriptor;
		const previousAuthority = keys.forPriorScope(previousDescriptor.scopeId, previousDescriptor.keyId);
		const previousMetadata = await openFileMetadata(previousDescriptor, file.path, previousAuthority);
		const opened = await openFile(new Uint8Array(body), file.path, original ? previousAuthority : keys.forPath(file.path));
		if (opened.metadata.hash !== previousMetadata.hash || opened.metadata.size !== previousMetadata.size) throw new Error('Folder conversion does not match the original note');
		if (original) {
			const sealed = await sealFile({ path: file.path, content: opened.content, contentType: opened.metadata.contentType, publicData: await createReminderProjection(bundle, file.path, opened.content.buffer) }, keys.forPath(file.path));
			bytes = sealed.bytes;
		} else bytes = new Uint8Array(body);
		plainHash = previousMetadata.hash;
	} else if (!original) {
		if (contentType !== ENCRYPTED_FILE_CONTENT_TYPE) throw new Error('The original file failed integrity validation. Conversion remains paused.');
		const opened = await openFile(new Uint8Array(body), file.path, keys.forPath(file.path));
		if (opened.metadata.hash !== file.hash || opened.metadata.size !== file.size) throw new Error('Interrupted conversion does not match the original file');
		bytes = new Uint8Array(body); plainHash = opened.metadata.hash;
	} else {
		const sealed = await sealFile({ path: file.path, content: new Uint8Array(body), contentType: contentType ?? 'application/octet-stream', publicData: await createReminderProjection(bundle, file.path, body) }, keys.forPath(file.path));
		bytes = sealed.bytes; plainHash = sealed.metadata.hash;
	}
	return { bytes, plainHash };
}

/** Preserve the legacy receipt audience without granting access to other folders. */
export async function prepareConversionReceipt(receipt: ConversionReceipt, kind: 'reminder' | 'reading' | 'upload', bundle: VaultKeyBundle, keys: FileKeyAuthority) {
	const response: unknown = JSON.parse(receipt.response_json);
	const value = { ...(kind === 'upload' ? { kind } : {}), requestHash: receipt.request_hash, response };
	const context = { vaultId: bundle.vaultId, scopeId: 'vault', objectId: receipt.operation_id, purpose: 'reminder' as const };
	const scopes = [];
	for (const scope of bundle.scopes) {
		if (kind === 'upload' || kind === 'reading' && scope.purpose !== 'reading') continue;
		if (kind === 'reminder') {
			// Legacy responses contain either one reminder or only a success flag.
			const reminder = (response as { reminder?: { filePath?: unknown } } | null)?.reminder;
			if (reminder && (typeof reminder.filePath !== 'string' || !reminder.filePath.startsWith(scope.folderPath + '/'))) continue;
		}
		const key = keys.forPath(scope.folderPath + '/receipt.md').key;
		scopes.push({ id: scope.id, envelope: await encryptJson(value, key, { ...context, scopeId: scope.id }) });
	}
	return { ...(kind === 'reminder' ? {} : { kind }), operationId: receipt.operation_id, scopes,
		vault: await encryptJson(value, keys.forVaultMetadata().key, context) };
}
