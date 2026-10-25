import { validateEncryptionState, type EncryptionServerState } from '../../encryption/server-state';
import { HttpError, type WorkerApiHttpClient } from '../worker-api/http';

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
