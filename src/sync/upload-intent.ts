import type { BatchUploadFile } from '../protocol/sync-types';
import { isRecord } from '../platform/validation';
import { isUploadSession } from './upload-diagnostics';
import { isSyncDate, isSyncHash, isSyncPath, isSyncSequence } from '../protocol/sync-validation';
import { MAX_FILE_SIZE_BYTES } from '../protocol/sync-limits';
import { arrayBufferToBase64, base64ToArrayBuffer } from './encoding';
import { computeHash } from './hasher';
import { ENCRYPTED_FILE_CONTENT_TYPE, MAX_ENCRYPTED_FILE_BYTES, parseEncryptedFile } from '../encryption/file-format';

interface UploadPreimage { content: string; hash: string; size: number }
export type UploadIntent = { kind: 'local' } | { kind: 'merge'; preimage: UploadPreimage };
export type IntendedUpload = BatchUploadFile & { intent: UploadIntent };
export interface EncryptedUploadWire {
	format: 'crate-e2ee-v1';
	/** Absent only in journals written before folder-move support. */
	generation?: number;
	content: string;
	hash: string;
	size: number;
	contentType: typeof ENCRYPTED_FILE_CONTENT_TYPE;
	expectedHash: string | null;
}
export type JournalUpload = IntendedUpload & { operationId: string; origin: { clientSession: string; at: string }; encryptedWire?: EncryptedUploadWire };
export type PrepareUploadWire = (file: JournalUpload) => Promise<EncryptedUploadWire | undefined>;

export function uploadWire(file: JournalUpload): BatchUploadFile {
	const { intent: _intent, origin: _origin, encryptedWire, ...plain } = file;
	if (!encryptedWire) return plain;
	const { format: _format, generation: _generation, ...wire } = encryptedWire;
	return { ...plain, ...wire };
}

export async function mergeUploadIntent(content: ArrayBuffer): Promise<UploadIntent> {
	return { kind: 'merge', preimage: { content: arrayBufferToBase64(content), hash: await computeHash(content), size: content.byteLength } };
}

async function validateBytes(value: unknown, limit = MAX_FILE_SIZE_BYTES): Promise<void> {
	if (!isRecord(value) || !isSyncHash(value.hash) || !isSyncSequence(value.size) || value.size > limit
		|| typeof value.content !== 'string' || value.content.length > Math.ceil(limit / 3) * 4
		|| value.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.content)) throw new Error('Invalid upload journal bytes');
	const content = base64ToArrayBuffer(value.content);
	if (content.byteLength !== value.size || await computeHash(content) !== value.hash) throw new Error('Upload journal content failed integrity validation');
}

export async function validateUploadIntent(value: unknown): Promise<void> {
	if (!isRecord(value) || !isSyncPath(value.path) || typeof value.contentType !== 'string'
		|| !(value.expectedHash === null || isSyncHash(value.expectedHash)) || !isRecord(value.intent)) throw new Error('Invalid upload journal intent');
	if (!isRecord(value.origin) || !isUploadSession(value.origin.clientSession) || !isSyncDate(value.origin.at)) throw new Error('Invalid upload journal origin');
	await validateBytes(value);
	if (value.encryptedWire !== undefined) {
		const wire = value.encryptedWire;
		if (!isRecord(wire) || wire.format !== 'crate-e2ee-v1' || wire.contentType !== ENCRYPTED_FILE_CONTENT_TYPE
			|| (wire.generation !== undefined && (typeof wire.generation !== 'number' || !Number.isSafeInteger(wire.generation) || wire.generation < 1))
			|| !(wire.expectedHash === null || isSyncHash(wire.expectedHash))) throw new Error('Invalid encrypted upload journal');
		await validateBytes(wire, MAX_ENCRYPTED_FILE_BYTES);
		parseEncryptedFile(new Uint8Array(base64ToArrayBuffer(wire.content as string)));
	}
	if (value.intent.kind === 'merge') await validateBytes(value.intent.preimage);
	else if (value.intent.kind !== 'local') throw new Error('Unsupported upload journal intent');
}
