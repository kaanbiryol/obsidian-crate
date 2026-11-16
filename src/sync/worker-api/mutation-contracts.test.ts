import { describe, expect, it } from 'vitest';
import { parseBatchDelete, parseBatchDownload, parseBatchUpload, parseUploadResult } from './mutation-contracts';

const INVALID = 'Invalid or unsupported sync write response. The change is preserved for retry.';

describe('write response contracts', () => {
	it('accepts the upload receipts the Worker returns, keeping unknown failure codes', () => {
		const success = { success: true, path: 'a.md', hash: 'h', revision: 'r1' };
		expect(parseUploadResult(success)).toBe(success);
		const refused = { success: false, path: 'a.md', error: 'Remote file changed', code: 'version_conflict', status: 409, currentHash: null };
		expect(parseUploadResult(refused)).toBe(refused);
		expect(parseUploadResult({ success: false, path: 'a.md', code: 'from_a_newer_server' })).toMatchObject({ code: 'from_a_newer_server' });
	});

	it.each([
		null, [], { path: 'a.md' }, { success: 'yes', path: 'a.md' }, { success: true, path: 7 },
		{ success: true, path: 'a.md', revision: 1 }, { success: false, path: 'a.md', status: 'conflict' },
		{ success: false, path: 'a.md', currentHash: 5 },
	])('rejects a malformed upload receipt %#', value => {
		expect(() => parseUploadResult(value)).toThrow(INVALID);
	});

	it('checks every batch upload result', () => {
		const response = { success: true, results: [{ success: true, path: 'a.md', hash: 'h', revision: 'r' }] };
		expect(parseBatchUpload(response)).toBe(response);
		expect(() => parseBatchUpload({ success: true })).toThrow(INVALID);
		expect(() => parseBatchUpload({ success: true, results: [{ success: true }] })).toThrow(INVALID);
	});

	it('accepts downloaded and failed batch entries, and keeps fields the types do not name', () => {
		const response = { files: [
			{ path: 'a.md', content: 'YQ==', hash: 'h', size: 1, contentType: 'text/markdown', revision: 'r', descriptor: 'sealed' },
			{ path: 'b.md', content: '', hash: '', size: 0, contentType: '', error: 'File not found' },
		] };
		expect(parseBatchDownload(response)).toBe(response);
		expect(() => parseBatchDownload({ files: [{ path: 'a.md', content: 'YQ==', hash: 'h', size: -1, contentType: '' }] })).toThrow(INVALID);
		expect(() => parseBatchDownload({ files: 'a.md' })).toThrow(INVALID);
	});

	it('checks deleted paths, receipts and failures of a batch delete', () => {
		const response = {
			success: false, deleted: ['a.md'],
			results: [{ path: 'a.md', revision: 'r2', consumedRevision: 'r1', deleteRequestId: 'id' }],
			errors: [{ path: 'b.md', error: 'Remote file changed', code: 'version_conflict', status: 409 }],
		};
		expect(parseBatchDelete(response)).toBe(response);
		expect(() => parseBatchDelete({ success: true })).toThrow(INVALID);
		expect(() => parseBatchDelete({ success: true, deleted: [1] })).toThrow(INVALID);
		expect(() => parseBatchDelete({ success: true, deleted: [], errors: [{ path: 'b.md' }] })).toThrow(INVALID);
		expect(() => parseBatchDelete({ success: true, deleted: [], results: [{ revision: 'r' }] })).toThrow(INVALID);
	});
});
