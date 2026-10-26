import { expect, it } from 'vitest';
import type { IndexedReminder } from '@/reminders/data/reminder-index';
import { applyFileScanResult, type FileScanState } from './file-scan-result';
import { createReminderLookupStore } from './lookup-store';
import { createReminderOptimisticState } from './optimistic-state';
import type { ReminderIdentityOwners } from '../reminder-identity-owners';

function reminder(id: string, filePath: string, project = 'Work'): IndexedReminder {
	return { id, content: id, priority: 4, completed: false, project, filePath, lineNumber: 0, rawLine: `- [ ] ${id}` };
}

function state(reminders: IndexedReminder[], overrides: Partial<FileScanState> = {}): FileScanState {
	const lookupStore = createReminderLookupStore();
	lookupStore.rebuild(reminders);
	return {
		reminders, ambiguousOwners: [], sourceIssues: new Map(), scannedDigests: new Map(), discoveredProjects: new Set(),
		lookupStore, optimisticState: createReminderOptimisticState(), ...overrides,
	};
}

it('replaces the file entries and records its digest and project', () => {
	const current = state([reminder('a', 'Work.md'), reminder('b', 'Home.md', 'Home')], {
		sourceIssues: new Map([['Work.md', { path: 'Work.md', reason: 'old failure' }]]),
	});

	const outcome = applyFileScanResult(current, { filePath: 'Work.md', project: 'Work', digest: 'd1', result: { filePath: 'Work.md', reminders: [reminder('c', 'Work.md')], lineCount: 1 } });

	expect(outcome.applied).toBe(true);
	if (!outcome.applied) return;
	expect(outcome.reminders.map(item => item.id)).toEqual(['b', 'c']);
	expect(current.lookupStore.getById('a')).toBeUndefined();
	expect(current.lookupStore.getById('c')?.filePath).toBe('Work.md');
	expect(current.scannedDigests.get('Work.md')).toBe('d1');
	expect(current.sourceIssues.has('Work.md')).toBe(false);
	expect(current.discoveredProjects.has('Work')).toBe(true);
});

it('keeps previous entries and records a source issue when the scan failed', () => {
	const previous = [reminder('a', 'Work.md')];
	const current = state(previous, { scannedDigests: new Map([['Work.md', 'old']]) });

	const outcome = applyFileScanResult(current, { filePath: 'Work.md', project: 'Work', digest: 'd2', result: { filePath: 'Work.md', reminders: [], lineCount: 0, error: 'Unreadable', diagnostic: { code: 'invalid-markdown-encoding' } } });

	expect(outcome).toEqual({ applied: false, error: 'Unreadable' });
	expect(current.reminders).toBe(previous);
	expect(current.lookupStore.getById('a')).toBeDefined();
	expect(current.scannedDigests.has('Work.md')).toBe(false);
	expect(current.sourceIssues.get('Work.md')).toEqual({ path: 'Work.md', reason: 'Unreadable', diagnostic: { code: 'invalid-markdown-encoding' } });
});

it('transfers released identity owners from another file in one rebuild', () => {
	const batchOwners: ReminderIdentityOwners = new Map([['a', new Set(['Old.md'])], ['x', new Set(['Ambiguous.md'])]]);
	const current = state([reminder('a', 'Old.md')], { ambiguousOwners: [{ id: 'x', filePath: 'Ambiguous.md' }], batchOwners });

	const outcome = applyFileScanResult(current, {
		filePath: 'New.md', project: 'Work',
		result: { filePath: 'New.md', reminders: [reminder('a', 'New.md')], lineCount: 1, releasedOwners: [{ id: 'a', filePath: 'Old.md' }, { id: 'x', filePath: 'Ambiguous.md' }] },
	});

	expect(outcome.applied).toBe(true);
	if (!outcome.applied) return;
	expect(outcome.reminders).toEqual([reminder('a', 'New.md')]);
	expect(outcome.ambiguousOwners).toEqual([]);
	expect(current.lookupStore.getById('a')?.filePath).toBe('New.md');
	expect(current.lookupStore.getByFile('Old.md')).toEqual([]);
	expect(batchOwners.get('a')).toEqual(new Set(['New.md']));
	expect(batchOwners.get('x')?.size).toBe(0);
	expect(current.scannedDigests.has('New.md')).toBe(false);
});

it('clears optimistic state that the fresh scan confirms', () => {
	const current = state([reminder('a', 'Work.md')]);
	current.optimisticState.applyUpdate('a', { content: 'edited' });

	applyFileScanResult(current, { filePath: 'Work.md', project: 'Work', result: { filePath: 'Work.md', reminders: [{ ...reminder('a', 'Work.md'), content: 'edited' }], lineCount: 1 } });

	expect(current.optimisticState.getById('a', reminder('a', 'Work.md'))?.content).toBe('a');
});
