import type { SecretStorageService } from '../plugin/secret-storage';
import { SECRET_KEYS } from '../plugin/settings-types';
import { isEncryptionId } from '../encryption/encoding';
import type { EncryptionServerState } from '../encryption/server-state';
import { HttpError, WorkerApiHttpClient, TRANSFER_TIMEOUT_MS } from './worker-api/http';
import { readServerEncryption } from './encryption-conversion';

export interface EncryptionReset {
	version: 1;
	id: string;
	workerUrl: string;
	vaultId: string;
	generation: number;
	oldToken: string;
	replacementToken: string;
	automaticSync: boolean;
	phase: 'remote' | 'local' | 'upload';
	/** Missing on older checkpoints, whose begin outcome must be treated as uncertain. */
	beginState?: 'prepared' | 'attempted' | 'rejected';
}

export function loadEncryptionReset(storage: SecretStorageService): EncryptionReset | null {
	const raw = storage.get(SECRET_KEYS.ENCRYPTION_RESET);
	if (!raw) return null;
	const value = JSON.parse(raw) as Partial<EncryptionReset>;
	if (value.version !== 1 || !isEncryptionId(value.id) || !isEncryptionId(value.vaultId)
		|| !Number.isSafeInteger(value.generation) || value.generation! < 1 || typeof value.workerUrl !== 'string'
		|| !value.workerUrl || typeof value.oldToken !== 'string' || !value.oldToken
		|| typeof value.replacementToken !== 'string' || !/^[a-f0-9]{64}$/.test(value.replacementToken)
		|| typeof value.automaticSync !== 'boolean' || !['remote', 'local', 'upload'].includes(value.phase ?? '')
		|| (value.beginState !== undefined && !['prepared', 'attempted', 'rejected'].includes(value.beginState))) {
		throw new Error('The saved encryption reset is invalid. Sync remains paused; preserve this device’s data.');
	}
	return value as EncryptionReset;
}

export function saveEncryptionReset(storage: SecretStorageService, reset: EncryptionReset): void {
	const value = JSON.stringify(reset);
	storage.set(SECRET_KEYS.ENCRYPTION_RESET, value);
	if (storage.get(SECRET_KEYS.ENCRYPTION_RESET) !== value) throw new Error('Could not verify the saved reset checkpoint. Sync remains paused.');
}

export function createEncryptionReset(workerUrl: string, oldToken: string, state: EncryptionServerState, automaticSync: boolean): EncryptionReset {
	if (state.mode !== 'active') throw new Error('Finish encryption conversion before turning encryption off');
	return { version: 1, id: crypto.randomUUID(), workerUrl, oldToken, vaultId: state.vaultId, generation: state.generation,
		replacementToken: Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''),
		automaticSync, phase: 'remote', beginState: 'prepared' };
}

export class EncryptionResetRejectedError extends Error {
	constructor() { super('The server rejected the reset before it started. Reopen Manage encryption or reconnect this device.'); }
}

interface ResetReceipt { id: string; vaultId: string; generation: number; complete: boolean }
function checkReceipt(reset: EncryptionReset, receipt: ResetReceipt): ResetReceipt {
	if (!receipt || receipt.id !== reset.id || receipt.vaultId !== reset.vaultId || receipt.generation !== reset.generation || typeof receipt.complete !== 'boolean') {
		throw new Error('The server did not confirm this device’s reset');
	}
	return receipt;
}

/** A changed tunnel must identify this exact reset, or the still-active original vault. */
export async function verifyEncryptionResetAddress(reset: EncryptionReset, createHttp: (token: string) => WorkerApiHttpClient): Promise<void> {
	try {
		const receipt = checkReceipt(reset, await createHttp(reset.replacementToken).requestJson<ResetReceipt>(`/encryption/reset?id=${encodeURIComponent(reset.id)}`));
		if (reset.phase !== 'remote' && !receipt.complete) throw new Error('The server has not completed this reset');
	} catch (error) {
		if (!(error instanceof HttpError) || error.status !== 401 || reset.phase !== 'remote') throw error;
		const state = await readServerEncryption(createHttp(reset.oldToken));
		if (!state || state.mode !== 'active' || state.vaultId !== reset.vaultId || state.generation !== reset.generation) {
			throw new Error('The new address does not identify the vault being reset');
		}
	}
}

/** Only the saved replacement credential may resume. Never start a new reset
 * when a response is lost, and never fall back on network/server errors. */
export async function resetRemoteEncryption(reset: EncryptionReset, progress: (message: string) => void, verify: () => void,
	createHttp: (token: string) => WorkerApiHttpClient, persist: (reset: EncryptionReset) => void): Promise<void> {
	if (reset.beginState === 'rejected') throw new EncryptionResetRejectedError();
	const route = `/encryption/reset?id=${encodeURIComponent(reset.id)}`;
	const http = createHttp(reset.replacementToken);
	const check = (receipt: ResetReceipt) => {
		verify();
		return checkReceipt(reset, receipt);
	};
	verify();
	let receipt: ResetReceipt;
	try { receipt = check(await http.requestJson<ResetReceipt>(route)); }
	catch (error) {
		if (!(error instanceof HttpError) || error.status !== 401) throw error;
		verify();
		const original = createHttp(reset.oldToken);
		if (!(await original.getServerInfo()).capabilities.includes('e2ee-reset-v1')) throw new Error('Update your Crate server before turning encryption off');
		verify();
		original.setEncryptionAuthority(reset.vaultId, reset.generation);
		const firstAttempt = reset.beginState === 'prepared';
		reset.beginState = 'attempted';
		persist(reset); // A crash or lost response from here on must preserve the replacement credential.
		try {
			receipt = check(await original.requestJson<ResetReceipt>(route, { method: 'POST', body: JSON.stringify({
				confirmation: 'delete-remote-data', replacementToken: reset.replacementToken,
			}) }, TRANSFER_TIMEOUT_MS));
		} catch (error) {
			if (firstAttempt && error instanceof HttpError && [400, 401, 403, 404, 405, 409, 428].includes(error.status)) {
				reset.beginState = 'rejected';
				persist(reset);
				throw new EncryptionResetRejectedError();
			}
			throw error;
		}
	}
	for (let pass = 0; !receipt.complete && pass < 10000; pass++) {
		progress('Deleting remote files, history and notification schedules…');
		verify();
		receipt = check(await http.requestJson<ResetReceipt>(route, { method: 'POST', body: '{}' }, TRANSFER_TIMEOUT_MS));
	}
	if (!receipt.complete) throw new Error('Reset progress is saved. Resume to finish deleting the remaining server data.');
}
