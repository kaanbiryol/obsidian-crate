import type { BatchUploadFile } from '../protocol/sync-types';
import { isRecord } from '../plugin/settings';
import { isUploadSession } from './upload-diagnostics';
import { isSyncDate, isSyncHash, isSyncPath, isSyncSequence } from '../protocol/sync-validation';
import { MAX_FILE_SIZE_BYTES } from '../protocol/sync-limits';
import { arrayBufferToBase64, base64ToArrayBuffer } from './encoding';
import { computeHash } from './hasher';

interface UploadPreimage { content: string; hash: string; size: number }
export type UploadIntent = { kind: 'local' } | { kind: 'merge'; preimage: UploadPreimage };
export type IntendedUpload = BatchUploadFile & { intent: UploadIntent };
export type JournalUpload = IntendedUpload & { operationId: string; origin: { clientSession: string; at: string } };

export async function mergeUploadIntent(content: ArrayBuffer): Promise<UploadIntent> {
	return { kind: 'merge', preimage: { content: arrayBufferToBase64(content), hash: await computeHash(content), size: content.byteLength } };
}

async function validateBytes(value: unknown): Promise<void> {
	if (!isRecord(value) || !isSyncHash(value.hash) || !isSyncSequence(value.size) || value.size > MAX_FILE_SIZE_BYTES
		|| typeof value.content !== 'string' || value.content.length > Math.ceil(MAX_FILE_SIZE_BYTES / 3) * 4
		|| value.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.content)) throw new Error('Invalid upload journal bytes');
	const content = base64ToArrayBuffer(value.content);
	if (content.byteLength !== value.size || await computeHash(content) !== value.hash) throw new Error('Upload journal content failed integrity validation');
}

export async function validateUploadIntent(value: unknown): Promise<void> {
	if (!isRecord(value) || !isSyncPath(value.path) || typeof value.contentType !== 'string'
		|| !(value.expectedHash === null || isSyncHash(value.expectedHash)) || !isRecord(value.intent)) throw new Error('Invalid upload journal intent');
	if (!isRecord(value.origin) || !isUploadSession(value.origin.clientSession) || !isSyncDate(value.origin.at)) throw new Error('Invalid upload journal origin');
	await validateBytes(value);
	if (value.intent.kind === 'merge') await validateBytes(value.intent.preimage);
	else if (value.intent.kind !== 'local') throw new Error('Unsupported upload journal intent');
}
