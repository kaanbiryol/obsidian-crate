import { describe, expect, it } from 'vitest';
import { fileFailure, isQueueTerminalFailure, isVersionConflict, isVersionConflictError, refusedUploadResult } from './failures';
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

	it('keeps the status, protocol code and current hash of a file failure', () => {
		expect(fileFailure('a.md', new HttpError('Taken', 409, null, 'namespace_conflict', 'b'.repeat(64))))
			.toStrictEqual({ path: 'a.md', error: 'Taken', status: 409, code: 'namespace_conflict', currentHash: 'b'.repeat(64) });
		expect(fileFailure('a.md', new HttpError('Busy', 503, null, 'rate_limited')))
			.toStrictEqual({ path: 'a.md', error: 'Busy', status: 503 });
		expect(fileFailure('a.md', new Error('Disk full'))).toStrictEqual({ path: 'a.md', error: 'Disk full' });
	});

	it('classifies a file failure by its code as well as its status', () => {
		const classify = (error: HttpError) => {
			const failure = fileFailure('a.md', error);
			return { replan: isVersionConflict(failure.status, failure.code), terminal: isQueueTerminalFailure(failure.status, failure.code) };
		};
		// A namespace conflict shares the 409 status, but replanning cannot clear it.
		expect(classify(new HttpError('Taken', 409, null, 'namespace_conflict'))).toEqual({ replan: false, terminal: true });
		expect(classify(new HttpError('Changed', 409))).toEqual({ replan: true, terminal: false });
		expect(classify(new HttpError('Changed', 409, null, 'version_conflict'))).toEqual({ replan: true, terminal: false });
		expect(classify(new HttpError('Changed', 412, null, 'rate_limited'))).toEqual({ replan: true, terminal: false });
	});

	it('recognizes only thrown request errors that a replan can resolve', () => {
		expect(isVersionConflictError(new HttpError('Changed', 412))).toBe(true);
		expect(isVersionConflictError(new HttpError('Taken', 409, null, 'namespace_conflict'))).toBe(false);
		expect(isVersionConflictError(new Error('Changed'))).toBe(false);
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
