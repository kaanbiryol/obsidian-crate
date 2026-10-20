import { isRecord, isSha256Hex } from '../../platform/validation';
import { reminderOperationDay } from '../../protocol/reminder-operation';
import { isSyncDate, isSyncSequence } from '../../protocol/sync-validation';

export const MAX_UPLOAD_DIAGNOSTICS = 50;
export type UploadApplyPhase = 'local-applied' | 'local-deferred' | 'local-apply-failed';
export type UploadPhase = 'prepared' | 'replaying' | 'remote-committed' | 'rejected' | 'checkpointed' | UploadApplyPhase;
export interface UploadDiagnostic {
	at: string;
	clientSession: string;
	operationId: string;
	kind: 'local' | 'merge';
	phase: UploadPhase;
	generation: number;
	pathHash: string;
	uploadHash: string;
	baseHash: string;
	appliedHash?: string;
}
const phases = new Set(['prepared', 'replaying', 'remote-committed', 'rejected', 'checkpointed', 'local-applied', 'local-deferred', 'local-apply-failed']);
export const isUploadSession = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

/** Diagnostic corruption never gains authority or bypasses export redaction. */
export function normalizeUploadDiagnostics(value: unknown): UploadDiagnostic[] {
	if (!Array.isArray(value)) return [];
	const result: UploadDiagnostic[] = [];
	for (const row of value.slice(-MAX_UPLOAD_DIAGNOSTICS)) {
		if (!isRecord(row) || !isSyncDate(row.at) || !isUploadSession(row.clientSession)
			|| typeof row.operationId !== 'string' || reminderOperationDay(row.operationId) === null
			|| row.kind !== 'local' && row.kind !== 'merge' || typeof row.phase !== 'string' || !phases.has(row.phase)
			|| !isSyncSequence(row.generation) || !isSha256Hex(row.pathHash) || !isSha256Hex(row.uploadHash) || !isSha256Hex(row.baseHash)) continue;
		result.push({ at: row.at, clientSession: row.clientSession, operationId: row.operationId, kind: row.kind,
			phase: row.phase as UploadPhase, generation: row.generation, pathHash: row.pathHash, uploadHash: row.uploadHash, baseHash: row.baseHash,
			...(isSha256Hex(row.appliedHash) ? { appliedHash: row.appliedHash } : {}) });
	}
	return result;
}
