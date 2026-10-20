import type { BatchUploadFile } from '../protocol/sync-types';
import { isRecord, isSha256Hex } from '../platform/validation';
import { isUploadSession } from './upload-diagnostics';
import { isSyncDate, isSyncPath, isSyncSequence } from '../protocol/sync-validation';
import { MAX_FILE_SIZE_BYTES } from '../protocol/sync-limits';
import { arrayBufferToBase64, base64ToArrayBuffer } from './encoding';
import { ENCRYPTED_FILE_CONTENT_TYPE, MAX_ENCRYPTED_FILE_BYTES, parseEncryptedFile } from '../encryption/file-format';
import { sha256Hex } from '../platform/sha256';

interface UploadPreimage { content: string; hash: string; size: number }
export type UploadIntent = { kind: 'local' } | { kind: 'merge'; preimage: UploadPreimage };
export type IntendedUpload = BatchUploadFile & { intent: UploadIntent };
export interface EncryptedUploadWire {
	format: 'crate-e2ee-v1';
	generation: number;
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
	return { kind: 'merge', preimage: { content: arrayBufferToBase64(content), hash: await sha256Hex(content), size: content.byteLength } };
}

async function validateBytes(value: unknown, limit = MAX_FILE_SIZE_BYTES, verifyContent = true): Promise<void> {
	if (!isRecord(value) || !isSha256Hex(value.hash) || !isSyncSequence(value.size) || value.size > limit
		|| typeof value.content !== 'string' || value.content.length > Math.ceil(limit / 3) * 4
		|| value.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.content)) throw new Error('Invalid upload journal bytes');
	if (!verifyContent) return;
	const content = base64ToArrayBuffer(value.content);
	if (content.byteLength !== value.size || await sha256Hex(content) !== value.hash) throw new Error('Upload journal content failed integrity validation');
}

/** `sealedInMemory` skips rehashing bytes that encryption just produced and
 * checked in this process; entries read from disk must omit it. */
export async function validateUploadIntent(value: unknown, sealedInMemory = false): Promise<void> {
	if (!isRecord(value) || !isSyncPath(value.path) || typeof value.contentType !== 'string'
		|| !(value.expectedHash === null || isSha256Hex(value.expectedHash)) || !isRecord(value.intent)) throw new Error('Invalid upload journal intent');
	if (!isRecord(value.origin) || !isUploadSession(value.origin.clientSession) || !isSyncDate(value.origin.at)) throw new Error('Invalid upload journal origin');
	await validateBytes(value, MAX_FILE_SIZE_BYTES, !sealedInMemory);
	if (value.encryptedWire !== undefined) {
		const wire = value.encryptedWire;
		if (!isRecord(wire) || wire.format !== 'crate-e2ee-v1' || wire.contentType !== ENCRYPTED_FILE_CONTENT_TYPE
			|| typeof wire.generation !== 'number' || !Number.isSafeInteger(wire.generation) || wire.generation < 1
			|| !(wire.expectedHash === null || isSha256Hex(wire.expectedHash))) throw new Error('Invalid encrypted upload journal');
		await validateBytes(wire, MAX_ENCRYPTED_FILE_BYTES, !sealedInMemory);
		if (!sealedInMemory) parseEncryptedFile(new Uint8Array(base64ToArrayBuffer(wire.content as string)));
	}
	if (value.intent.kind === 'merge') await validateBytes(value.intent.preimage);
	else if (value.intent.kind !== 'local') throw new Error('Unsupported upload journal intent');
}
