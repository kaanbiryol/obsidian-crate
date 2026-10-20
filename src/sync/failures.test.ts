import { describe, expect, it } from 'vitest';
import { isQueueTerminalFailure, isVersionConflict, refusedUploadResult } from './failures';
import { HttpError } from './worker-api/http';

describe('sync failure classification', () => {
	it('treats a version-conflict code or a precondition status as a replannable conflict', () => {
		expect(isVersionConflict(undefined, 'version_conflict')).toBe(true);
		expect(isVersionConflict(409)).toBe(true);
		expect(isVersionConflict(412, 'storage')).toBe(true);
		expect(isVersionConflict(409, 'namespace_conflict')).toBe(false);
		expect(isVersionConflict(503)).toBe(false);
	});

	it('keeps namespace conflicts terminal for the queue', () => {
		expect(isQueueTerminalFailure(409, 'namespace_conflict')).toBe(true);
		expect(isQueueTerminalFailure(409, 'version_conflict')).toBe(false);
		expect(isQueueTerminalFailure(503)).toBe(false);
		expect(isQueueTerminalFailure(undefined)).toBe(false);
	});

	it('converts only refused conditional writes into failed upload receipts', () => {
		expect(refusedUploadResult('a.md', new HttpError('Taken', 409, null, 'namespace_conflict')))
			.toEqual({ success: false, path: 'a.md', status: 409, code: 'namespace_conflict', error: 'Taken' });
		const unavailable = new HttpError('Unavailable', 503, null, 'storage');
		expect(() => refusedUploadResult('a.md', unavailable)).toThrow(unavailable);
		const local = new Error('Disk full');
		expect(() => refusedUploadResult('a.md', local)).toThrow(local);
	});
});
