import { validateEncryptionState, type EncryptionServerState } from '../../encryption/server-state';
import type { WorkerApiHttpClient } from '../worker-api/http';

interface EncryptionFileProgress { completed: number; total?: number }
export type EncryptionProgress = (message: string, files?: EncryptionFileProgress) => void;

export async function readServerEncryption(http: WorkerApiHttpClient, timeout?: number): Promise<EncryptionServerState | null> {
	const result = await http.requestJson<{ encryption: unknown }>('/encryption', {}, timeout);
	if (result.encryption === null) return null;
	validateEncryptionState(result.encryption);
	return result.encryption;
}
