import { expect, it } from 'vitest';
import type { IndexedReminder } from '@/reminders/data/reminder-index';
import { applyFileScanResult, applyVaultScanResult, type FileScanState, type VaultScanState } from './file-scan-result';
import type { ScanResult } from '../vaultScanner';
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

function vaultState(overrides: Partial<VaultScanState> = {}): VaultScanState {
	return { reminders: [], ambiguousOwners: [], sourceIssues: new Map(), discoveredProjects: new Set(), isLoaded: true, ...overrides };
}

function scan(overrides: Partial<ScanResult> = {}): ScanResult {
	return { reminders: [], issues: [], filesScanned: 0, totalLines: 0, scanDurationMs: 0, discoveredProjects: [], ...overrides };
}

it('replaces scanned files and keeps held-back and failed files from the previous index', () => {
	const previousIssue = { path: 'Held.md', reason: 'old failure' };
	const current = vaultState({
		reminders: [reminder('old', 'Work.md'), reminder('held', 'Held.md'), reminder('broken', 'Broken.md')],
		sourceIssues: new Map([['Held.md', previousIssue], ['Gone.md', { path: 'Gone.md', reason: 'stale' }]]),
	});

	const outcome = applyVaultScanResult(current, scan({
		reminders: [reminder('new', 'Work.md'), reminder('unwritten', 'Held.md')],
		issues: [{ path: 'Broken.md', reason: 'failed' }],
		discoveredProjects: ['Work'],
		deferredPaths: ['Held.md'],
		writeDeferredPaths: ['Work.md'],
	}));

	expect(outcome.complete).toBe(true);
	expect(outcome.reminders.map(item => item.id)).toEqual(['new', 'held', 'broken']);
	expect([...outcome.sourceIssues.keys()]).toEqual(['Broken.md', 'Held.md']);
	expect(outcome.sourceIssues.get('Held.md')).toBe(previousIssue);
	expect([...outcome.discoveredProjects]).toEqual(['Work']);
	expect(outcome.retryPaths).toEqual(['Held.md', 'Work.md']);
	expect(current.sourceIssues.has('Gone.md')).toBe(true);
});

it('shows held-back files as read before the first load', () => {
	const outcome = applyVaultScanResult(vaultState({ isLoaded: false }), scan({ reminders: [reminder('a', 'Held.md')], deferredPaths: ['Held.md'] }));

	expect(outcome.reminders.map(item => item.id)).toEqual(['a']);
});

it('keeps loaded reminders and adds issues when a scan stopped early', () => {
	const loaded = vaultState({ reminders: [reminder('a', 'Work.md')], discoveredProjects: new Set(['Work']) });
	const stopped = scan({ deferred: true, reminders: [reminder('b', 'Home.md')], issues: [{ path: 'Home.md', reason: 'failed' }], discoveredProjects: ['Home'] });

	const outcome = applyVaultScanResult(loaded, stopped);
	expect(outcome).toMatchObject({ complete: false, retryPaths: [] });
	expect(outcome.reminders).toBe(loaded.reminders);
	expect([...outcome.discoveredProjects]).toEqual(['Work']);
	expect(outcome.sourceIssues.get('Home.md')?.reason).toBe('failed');
	expect(loaded.sourceIssues.size).toBe(0);

	const first = applyVaultScanResult(vaultState({ isLoaded: false }), stopped);
	expect(first.reminders.map(item => item.id)).toEqual(['b']);
	expect([...first.discoveredProjects]).toEqual(['Home']);
});
