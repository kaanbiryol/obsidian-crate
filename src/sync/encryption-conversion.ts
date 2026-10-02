import { FileKeyAuthority } from '../encryption/file-authority';
import { bindEncryptionScopes } from '../encryption/scope-binding';
import { openFile, openFileMetadata, sealFile } from '../encryption/file-codec';
import { ENCRYPTED_FILE_CONTENT_TYPE, type EncryptedFileDescriptor } from '../encryption/file-format';
import { encryptJson } from '../encryption/envelope';
import { createReminderProjection } from '../encryption/reminder-projection';
import { createEncryptionState, validateEncryptionState, isReadingScopeExtension, isEncryptionScopeMove, ENCRYPTION_FOLDER_MOVES_CAPABILITY, READING_ENCRYPTION_CAPABILITY, type EncryptionServerState } from '../encryption/server-state';
import { sealRecoveryBundle, type VaultKeyBundle } from '../encryption/key-bundle';
import { parseSharedCheckpointDocument } from '../protocol/history-checkpoints';
import { computeHash } from './hasher';
import { WorkerApiHttpClient, TRANSFER_TIMEOUT_MS, getHeader, HttpError } from './worker-api/http';

interface ConversionFile { path: string; revision: string; hash: string; size: number; previous_descriptor?: string | null }
interface Receipt { operation_id: string; request_hash: string; response_json: string }
export interface EncryptionFileProgress { completed: number; total?: number }
export type EncryptionProgress = (message: string, files?: EncryptionFileProgress) => void;

export async function readServerEncryption(http: WorkerApiHttpClient, timeout?: number): Promise<EncryptionServerState | null> {
	let result: { encryption: unknown };
	try { result = await http.requestJson<{ encryption: unknown }>('/encryption', {}, timeout); }
	catch (error) { if (error instanceof HttpError && error.status === 404) return null; throw error; }
	if (result.encryption === null) return null;
	validateEncryptionState(result.encryption);
	return result.encryption;
}

export function assertEncryptionKeys(state: EncryptionServerState, bundle: VaultKeyBundle): void {
	if (state.vaultId !== bundle.vaultId || state.generation !== bundle.generation || state.keyId !== bundle.vault.id
		|| state.scopes.length !== bundle.scopes.length || state.scopes.some(scope => !bundle.scopes.some(key => key.id === scope.id
			&& key.folderPath === scope.folderPath && key.purpose === scope.purpose && key.accessId === scope.accessId && key.data.id === scope.keyId && key.notifications.id === scope.notificationKeyId))) throw new Error('Recover this server’s encryption keys before continuing');
}

/** One file at a time bounds mobile memory. The server freezes ordinary writes,
 * retains the first encrypted replacement and reconciles interrupted R2/D1 work. */
export async function convertEncryptedVault(http: WorkerApiHttpClient, bundle: VaultKeyBundle, recoveryCode: string, progress: EncryptionProgress): Promise<void> {
	progress('Preparing encrypted storage');
	if (bundle.scopes.some(scope => scope.purpose === 'reading') && !(await http.getServerInfo()).capabilities.includes(READING_ENCRYPTION_CAPABILITY)) throw new Error('Update your Crate server before encrypting Reading.');
	let state = await readServerEncryption(http);
	const proposed = state && createEncryptionState(bundle, state.recovery);
	const moving = state && proposed && isEncryptionScopeMove(state, proposed);
	if (moving && !(await http.getServerInfo()).capabilities.includes(ENCRYPTION_FOLDER_MOVES_CAPABILITY)) throw new Error('Update your Crate server before moving encrypted folders.');
	if (state && proposed && (moving || isReadingScopeExtension(state, proposed))) {
		state = await bindEncryptionScopes(createEncryptionState(bundle, await sealRecoveryBundle(bundle, recoveryCode)), bundle);
		await http.requestJson('/encryption/conversion', { method: 'POST', body: JSON.stringify(state) });
	} else if (state) assertEncryptionKeys(state, bundle);
	else {
		state = await bindEncryptionScopes(createEncryptionState(bundle, await sealRecoveryBundle(bundle, recoveryCode)), bundle);
		await http.requestJson('/encryption/conversion', { method: 'POST', body: JSON.stringify(state) });
	}
	http.setEncryptionAuthority(bundle.vaultId, bundle.generation);
	if (state.mode === 'active') return;
	const keys = await FileKeyAuthority.fromVault(bundle);
	const root = keys.forVaultMetadata();
	let completed = 0, total: number | undefined, firstPage = true;
	while (true) {
		const page = await http.requestJson<{ files: ConversionFile[]; receipts: Receipt[]; uploads: Receipt[]; reading?: Receipt[]; remainingFiles?: number; captures?: Array<{ id: string; path: string; note: string }> }>('/encryption/conversion' + (firstPage ? '?includeProgress=1' : ''));
		if (firstPage && Number.isSafeInteger(page.remainingFiles) && page.remainingFiles! >= page.files.length) total = page.remainingFiles;
		firstPage = false;
		if (!page.files.length && !page.receipts.length && !page.uploads.length && !page.reading?.length && !page.captures?.length) break;
		for (const capture of page.captures ?? []) {
			progress('Encrypting pending Reading captures');
			const bytes = new TextEncoder().encode(capture.note);
			const sealed = await sealFile({ path: capture.path, content: bytes, contentType: 'text/markdown', publicData: await createReminderProjection(bundle, capture.path, bytes.buffer) }, keys.forPath(capture.path));
			await http.requestJson('/encryption/conversion/reading-capture', { method: 'PUT', body: JSON.stringify({ id: capture.id, content: new TextDecoder().decode(sealed.bytes) }) });
		}
		for (const file of page.files) {
			progress('Encrypting files and retained versions', { completed, total });
			const route = `/encryption/conversion/file?revision=${encodeURIComponent(file.revision)}`;
			const { body, headers } = await http.requestBinary(route, {}, TRANSFER_TIMEOUT_MS);
			let bytes: Uint8Array<ArrayBuffer>;
			let plainHash: string;
			// Original metadata is authoritative even if plaintext resembles our wire format.
			const original = body.byteLength === file.size && await computeHash(body) === file.hash;
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
				if (getHeader(headers, 'Content-Type') !== ENCRYPTED_FILE_CONTENT_TYPE) throw new Error('The original file failed integrity validation. Conversion remains paused.');
				const opened = await openFile(new Uint8Array(body), file.path, keys.forPath(file.path));
				if (opened.metadata.hash !== file.hash || opened.metadata.size !== file.size) throw new Error('Interrupted conversion does not match the original file');
				bytes = new Uint8Array(body); plainHash = opened.metadata.hash;
			} else {
				const sealed = await sealFile({ path: file.path, content: new Uint8Array(body), contentType: getHeader(headers, 'Content-Type') ?? 'application/octet-stream', publicData: await createReminderProjection(bundle, file.path, body) }, keys.forPath(file.path));
				bytes = sealed.bytes; plainHash = sealed.metadata.hash;
			}
			const receipt = await http.requestJson<{ descriptor: EncryptedFileDescriptor }>(route, { method: 'PUT', body: bytes.buffer, contentType: ENCRYPTED_FILE_CONTENT_TYPE }, TRANSFER_TIMEOUT_MS);
			if ((await openFileMetadata(receipt.descriptor, file.path, keys.forPath(file.path))).hash !== plainHash) throw new Error('The conversion acknowledgment does not match the original file');
			completed++;
			progress('Encrypting files and retained versions', { completed, total });
		}
		for (const receipt of page.receipts) {
			progress('Encrypting saved reminder responses');
			const response: unknown = JSON.parse(receipt.response_json);
			const value = { requestHash: receipt.request_hash, response };
			const context = { vaultId: bundle.vaultId, scopeId: 'vault', objectId: receipt.operation_id, purpose: 'reminder' as const };
			const scopes = [];
			for (const scope of bundle.scopes) {
				// Legacy responses contain either one reminder or only a success flag.
				// Never grant a different folder access to its private reminder text.
				const reminder = (response as { reminder?: { filePath?: unknown } } | null)?.reminder;
				if (reminder && (typeof reminder.filePath !== 'string' || !reminder.filePath.startsWith(scope.folderPath + '/'))) continue;
				const key = keys.forPath(scope.folderPath + '/receipt.md').key;
				scopes.push({ id: scope.id, envelope: await encryptJson(value, key, { ...context, scopeId: scope.id }) });
			}
			await http.requestJson('/encryption/conversion/receipt', { method: 'PUT', body: JSON.stringify({ operationId: receipt.operation_id, vault: await encryptJson(value, root.key, context), scopes }) });
		}
		for (const receipt of page.reading ?? []) {
			const context = { vaultId: bundle.vaultId, scopeId: 'vault', objectId: receipt.operation_id, purpose: 'reminder' as const };
			const value = { requestHash: receipt.request_hash, response: JSON.parse(receipt.response_json) as unknown };
			const scopes = [];
			for (const scope of bundle.scopes.filter(scope => scope.purpose === 'reading')) scopes.push({ id: scope.id, envelope: await encryptJson(value, keys.forPath(scope.folderPath + '/receipt.md').key, { ...context, scopeId: scope.id }) });
			await http.requestJson('/encryption/conversion/receipt', { method: 'PUT', body: JSON.stringify({ kind: 'reading', operationId: receipt.operation_id, scopes, vault: await encryptJson(value, root.key, context) }) });
		}
		for (const receipt of page.uploads) {
			const value = { kind: 'upload', requestHash: receipt.request_hash, response: JSON.parse(receipt.response_json) as unknown };
			await http.requestJson('/encryption/conversion/receipt', { method: 'PUT', body: JSON.stringify({ kind: 'upload', operationId: receipt.operation_id, scopes: [],
				vault: await encryptJson(value, root.key, { vaultId: bundle.vaultId, scopeId: 'vault', objectId: receipt.operation_id, purpose: 'reminder' }) }) });
		}
	}
	progress('Encrypting shared settings');
	const settings = await http.requestJson<{ converted?: boolean; settings?: unknown }>('/encryption/conversion/settings');
	if (!settings.converted) await http.requestJson('/encryption/conversion/settings', { method: 'PUT', body: JSON.stringify({ version: 1, vaultId: bundle.vaultId, keyId: bundle.vault.id,
		envelope: await encryptJson(settings.settings ?? null, root.key, { vaultId: bundle.vaultId, scopeId: 'vault', objectId: 'shared-settings', purpose: 'settings' }) }) });
	progress('Encrypting history checkpoints');
	let cursor: string | null = null;
	do {
		const page: { documents: Array<{ key: string; document: unknown }>; cursor: string | null } = await http.requestJson('/encryption/conversion/checkpoints' + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''));
		for (const item of page.documents) {
			const document = parseSharedCheckpointDocument(item.document);
			const encrypted = await encryptJson(document, root.key, { vaultId: bundle.vaultId, scopeId: 'vault', objectId: document.checkpoint.id, purpose: 'settings' });
			await http.requestJson('/encryption/conversion/checkpoint', { method: 'PUT', body: JSON.stringify({ key: item.key, encrypted }) }, TRANSFER_TIMEOUT_MS);
		}
		cursor = page.cursor;
	} while (cursor);
	progress('Removing old server copies and rebuilding encrypted notifications');
	for (let pass = 0; pass < 10000; pass++) {
		const result = await http.requestJson<{ pending?: boolean; encryption?: EncryptionServerState }>('/encryption/conversion/finish', { method: 'POST', body: '{}' }, TRANSFER_TIMEOUT_MS);
		if (result.encryption?.mode === 'active') { assertEncryptionKeys(result.encryption, bundle); progress('Encryption is enabled'); return; }
		if (!result.pending) throw new Error('The server did not confirm encryption activation');
	}
	throw new Error('Conversion is saved. Resume it to finish processing the remaining server data.');
}
