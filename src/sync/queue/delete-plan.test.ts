import { describe, expect, it } from 'vitest';
import { deferBlockedUploads, planQueueDeletes } from './delete-plan';

const deletes = [{ path: 'old.md' }, { path: 'other.md' }];
const renamedTo = (path: string) => path === 'old.md' ? 'new.md' : undefined;

describe('planQueueDeletes', () => {
	it('runs every delete after a clean flush', () => {
		expect(planQueueDeletes(deletes, { failures: [], failedUploads: new Set(), reconciling: false, hasTerminalFailure: false }, renamedTo))
			.toEqual({ ready: deletes, deferred: [] });
	});

	it('holds every delete while a retry or reconciliation will rerun them', () => {
		const failed = { failures: [{ status: 500 }], failedUploads: new Set(['x.md']) };
		expect(planQueueDeletes(deletes, { ...failed, reconciling: false, hasTerminalFailure: false }, renamedTo).ready).toEqual([]);
		expect(planQueueDeletes(deletes, { ...failed, reconciling: true, hasTerminalFailure: true }, renamedTo).ready).toEqual([]);
	});

	it('after a terminal failure holds only deletes renamed to a failed upload', () => {
		const outcome = { failures: [{ status: 413 }], failedUploads: new Set(['new.md']), reconciling: false, hasTerminalFailure: true };
		expect(planQueueDeletes(deletes, outcome, renamedTo)).toEqual({ ready: [{ path: 'other.md' }], deferred: [{ path: 'old.md' }] });
	});

	it('holds every delete when access was revoked', () => {
		const outcome = { failures: [{ status: 401 }], failedUploads: new Set<string>(), reconciling: false, hasTerminalFailure: true };
		expect(planQueueDeletes(deletes, outcome, renamedTo).ready).toEqual([]);
	});
});

it('defers an upload only while a failed delete still holds its namespace', () => {
	expect(deferBlockedUploads(['Note.md', 'b.md'], ['note.md'])).toEqual({ ready: ['b.md'], deferred: [{ path: 'Note.md', blocking: 'note.md' }] });
	expect(deferBlockedUploads(['Note.md'], [])).toEqual({ ready: ['Note.md'], deferred: [] });
});
