import { FileKeyAuthority } from '../encryption/file-authority';
import { bindEncryptionScopes } from '../encryption/scope-binding';
import { openFileMetadata, sealFile } from '../encryption/file-codec';
import { ENCRYPTED_FILE_CONTENT_TYPE, type EncryptedFileDescriptor } from '../encryption/file-format';
import { encryptJson } from '../encryption/envelope';
import { createReminderProjection } from '../encryption/reminder-projection';
import { createEncryptionState, validateEncryptionState, isReadingScopeExtension, isEncryptionScopeMove, ENCRYPTION_FOLDER_MOVES_CAPABILITY, READING_ENCRYPTION_CAPABILITY, type EncryptionServerState } from '../encryption/server-state';
import { sealRecoveryBundle, type VaultKeyBundle } from '../encryption/key-bundle';
import { parseSharedCheckpointDocument } from '../protocol/history-checkpoints';
import { prepareConversionFile, prepareConversionReceipt, type ConversionFile, type ConversionReceipt } from './encryption-conversion-content';
import { WorkerApiHttpClient, TRANSFER_TIMEOUT_MS, getHeader, HttpError } from './worker-api/http';

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
	let completed = 0, total: number | undefined, firstPage = true, pageCursor: string | undefined;
	while (true) {
		const query = firstPage ? '?includeProgress=1' : `?cursor=${encodeURIComponent(pageCursor ?? '')}`;
		const page = await http.requestJson<{ files: ConversionFile[]; receipts: ConversionReceipt[]; uploads: ConversionReceipt[]; reading?: ConversionReceipt[]; remainingFiles?: number; captures?: Array<{ id: string; path: string; note: string }>; cursor?: string }>('/encryption/conversion' + query);
		pageCursor = page.cursor;
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
			const { bytes, plainHash } = await prepareConversionFile(file, body, getHeader(headers, 'Content-Type'), bundle, keys);
			const receipt = await http.requestJson<{ descriptor: EncryptedFileDescriptor }>(route, { method: 'PUT', body: bytes.buffer, contentType: ENCRYPTED_FILE_CONTENT_TYPE }, TRANSFER_TIMEOUT_MS);
			if ((await openFileMetadata(receipt.descriptor, file.path, keys.forPath(file.path))).hash !== plainHash) throw new Error('The conversion acknowledgment does not match the original file');
			completed++;
			progress('Encrypting files and retained versions', { completed, total });
		}
		for (const receipt of page.receipts) {
			progress('Encrypting saved reminder responses');
			await http.requestJson('/encryption/conversion/receipt', { method: 'PUT', body: JSON.stringify(await prepareConversionReceipt(receipt, 'reminder', bundle, keys)) });
		}
		for (const receipt of page.reading ?? []) {
			await http.requestJson('/encryption/conversion/receipt', { method: 'PUT', body: JSON.stringify(await prepareConversionReceipt(receipt, 'reading', bundle, keys)) });
		}
		for (const receipt of page.uploads) {
			await http.requestJson('/encryption/conversion/receipt', { method: 'PUT', body: JSON.stringify(await prepareConversionReceipt(receipt, 'upload', bundle, keys)) });
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
