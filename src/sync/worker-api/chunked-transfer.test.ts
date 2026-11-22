import { expect, it, vi } from 'vitest';
import { SyncWorkerApi } from './sync';
import { HttpError, type WorkerApiHttpClient } from './http';
import { MAX_FILE_SIZE_BYTES, UPLOAD_PART_BYTES } from '../../protocol/sync-limits';

const size = UPLOAD_PART_BYTES + 10;
const file = () => { const bytes = new Uint8Array(size); bytes[0] = 1; bytes[size - 1] = 2; return bytes; };
const operationId = 'e1_00020000_11111111-1111-4111-8111-111111111111';

function api(http: Partial<WorkerApiHttpClient>) {
	vi.stubGlobal('window', { setTimeout: (run: () => void) => setTimeout(run, 0), clearTimeout });
	return new SyncWorkerApi({ supportsChunkedUploads: () => true, ...http } as WorkerApiHttpClient);
}

it('chooses parts only for large plaintext attachments on a server that takes them', () => {
	const sync = api({});
	expect(sync.usesChunkedUpload('video.bin', MAX_FILE_SIZE_BYTES + 1)).toBe(true);
	expect(sync.usesChunkedUpload('video.bin', MAX_FILE_SIZE_BYTES)).toBe(false);
	expect(sync.usesChunkedUpload('Big.md', MAX_FILE_SIZE_BYTES + 1)).toBe(false);
	expect(new SyncWorkerApi({ supportsChunkedUploads: () => false } as unknown as WorkerApiHttpClient).usesChunkedUpload('video.bin', MAX_FILE_SIZE_BYTES + 1)).toBe(false);
});

it('sends a large file in ordered parts, retrying a part after a server error, then completes it', async () => {
	const calls: Array<{ url: string; bytes?: number }> = [];
	let failures = 1;
	const requestJson = vi.fn(async (url: string, options: { body?: unknown }) => {
		calls.push({ url, ...(options.body instanceof ArrayBuffer ? { bytes: options.body.byteLength } : {}) });
		if (url.includes('action=begin')) return { session: { partBytes: UPLOAD_PART_BYTES } };
		if (url.includes('part=2') && failures-- > 0) throw new HttpError('Server unavailable', 503);
		if (url.includes('part=')) return { etag: `etag-${url.slice(-1)}` };
		expect(JSON.parse(options.body as string)).toMatchObject({ parts: [{ partNumber: 1, etag: 'etag-1' }, { partNumber: 2, etag: 'etag-2' }] });
		return { success: true, path: 'video.bin', hash: 'a'.repeat(64), revision: `__crate__/files/${'a'.repeat(64)}/00000000-0000-4000-8000-000000000000` };
	});
	const receipt = await api({ requestJson: requestJson as never }).uploadChunked('video.bin', file().buffer, 'a'.repeat(64), size, 'application/octet-stream', null, operationId);
	expect(receipt.success).toBe(true);
	expect(calls).toEqual([
		{ url: '/sync/upload-session?action=begin' },
		{ url: '/sync/upload-session?part=1', bytes: UPLOAD_PART_BYTES },
		{ url: '/sync/upload-session?part=2', bytes: 10 },
		{ url: '/sync/upload-session?part=2', bytes: 10 },
		{ url: '/sync/upload-session?action=complete' },
	]);
});

it('returns a stored receipt from begin without sending parts', async () => {
	const requestJson = vi.fn(async () => ({ success: true, path: 'video.bin', hash: 'a'.repeat(64), revision: `__crate__/files/${'a'.repeat(64)}/00000000-0000-4000-8000-000000000000` }));
	expect((await api({ requestJson: requestJson as never }).uploadChunked('video.bin', file().buffer, 'a'.repeat(64), size, 'application/octet-stream', null, operationId)).success).toBe(true);
	expect(requestJson).toHaveBeenCalledOnce();
});

it('downloads a large file in ranges into one buffer and refuses a revision change between ranges', async () => {
	const content = file();
	const ranges: string[] = [];
	const requestBinary = vi.fn<WorkerApiHttpClient['requestBinary']>(async (_url, options = {}) => {
		const range = options.headers!.Range!;
		ranges.push(range);
		const [start, end] = range.slice(6).split('-').map(Number) as [number, number];
		const last = Math.min(end, size - 1);
		return { body: content.slice(start, last + 1).buffer, headers: { 'content-length': String(last - start + 1), 'content-range': `bytes ${start}-${last}/${size}`, 'x-crate-revision': 'r1', 'x-file-hash': 'h' } };
	});
	const downloaded = await api({ requestBinary }).downloadFile('video.bin', size);
	expect(ranges).toEqual([`bytes=0-${UPLOAD_PART_BYTES - 1}`, `bytes=${UPLOAD_PART_BYTES}-${2 * UPLOAD_PART_BYTES - 1}`]);
	expect(downloaded.size).toBe(size);
	expect(new Uint8Array(downloaded.content).at(-1)).toBe(2);
	// The first range comes from r1, the next from r2.
	let calls = 0;
	requestBinary.mockImplementation(async (_url, options = {}) => {
		const range = options.headers!.Range!;
		const [start, end] = range.slice(6).split('-').map(Number) as [number, number];
		const last = Math.min(end, size - 1);
		return { body: content.slice(start, last + 1).buffer, headers: { 'content-length': String(last - start + 1), 'content-range': `bytes ${start}-${last}/${size}`, 'x-crate-revision': calls++ ? 'r2' : 'r1', 'x-file-hash': 'h' } };
	});
	await expect(api({ requestBinary }).downloadFile('video.bin', size)).rejects.toThrow('changed on the server while downloading');
});
