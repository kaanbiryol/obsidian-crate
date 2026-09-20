import { afterEach, expect, it, vi } from 'vitest';
import { FakeElement, createObsidianUiModule } from '../../test/fakes/obsidian-ui';

vi.mock('obsidian', () => createObsidianUiModule());
import { renderConflictsPanel, renderPendingPanel } from './panels';

afterEach(() => vi.clearAllMocks());

it('shows active initial upload with an empty pending queue', () => {
    const element = new FakeElement('div');
    renderPendingPanel(element as never, [], false, false, { type: 'initial', current: 12, total: 20 });
    expect(element.collectText()).toContain('Preparing files: 12/20');
    expect(element.children[0]?.attributes.get('role')).toBe('status');
    expect(element.collectText()).not.toContain('All synced');
});

it('does not claim completion before transfer progress is available', () => {
    const element = new FakeElement('div');
    renderPendingPanel(element as never, [], false, true);
    expect(element.collectText()).toContain('Starting sync…');
    expect(element.collectText()).not.toContain('All synced');
});

it('shows the normal empty state after syncing finishes', () => {
    const element = new FakeElement('div');
    renderPendingPanel(element as never, [], false, false, null, 'Synced just now');
    expect(element.collectText()).toContain('All synced');
    expect(element.collectText()).toContain('Synced just now');
    expect(element.collectText()).not.toContain('Your vault is up to date.');
});

it('shows runtime saving progress after the engine finishes an unchanged sync', () => {
    const element = new FakeElement('div');
    renderPendingPanel(element as never, [], false, false, {
        type: 'sync', current: 0, total: 0, work: { phase: 'saving' },
    }, '', { status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 });
    expect(element.collectText()).toBe('Saving sync progress…');
    expect(element.children[0]?.attributes.get('role')).toBe('status');
});

it('replaces the pending file list with a loading indicator during sync', () => {
    const element = new FakeElement('div');
    renderPendingPanel(element as never, ['Notes/draft.md', 'delete:old.md'], false, true);
    expect(element.collectText()).toBe('Starting sync…');
    expect(element.children[0]?.classNames.has('crate-activity-loading')).toBe(true);
    expect(element.children[0]?.children[0]?.attributes.get('aria-hidden')).toBe('true');

    element.empty();
    renderPendingPanel(element as never, ['Notes/draft.md']);
    expect(element.collectText()).toContain('draft.md');
    expect(element.collectText()).not.toContain('Starting sync…');
});

it.each([false, true])('shows a conflict state without a duplicate sync subtitle (checking: %s)', checking => {
    const element = new FakeElement('div');
    renderConflictsPanel(element as never, [], checking);
    expect(element.collectText()).toBe(checking ? 'Checking for conflicts…' : 'No conflicts There are no files requiring attention.');
});

it.each([
 { status: 'idle' as const, lastSync: null, title: 'No completed sync yet' },
 { status: 'offline' as const, lastSync: '2026-09-12T10:00:00Z', title: 'You’re offline' },
])('does not claim completion for $title', ({ status, lastSync, title }) => {
 const element = new FakeElement('div');
 renderPendingPanel(element as never, [], false, false, null, '', { status, lastSync, lastError: null, pendingChanges: 0, conflictCount: 0 });
 expect(element.collectText()).toContain(title);
 expect(element.collectText()).not.toContain('All synced');
});

it('shows change progress independently of the pending queue size', () => {
    const element = new FakeElement('div');
    renderPendingPanel(element as never, ['queued.md'], false, true, { type: 'sync', current: 3, total: 12 });
    expect(element.collectText()).toBe('Processing changes: 3/12');
});

it('shows one spinner with the file count during uploads', () => {
    const element = new FakeElement('div');
    renderPendingPanel(element as never, [], false, true, null, '', {
        status: 'syncing', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0,
        work: { phase: 'uploading', current: 640, total: 1986 },
    });
    const indicator = element.children[0]?.children[0];
    expect(indicator?.classNames.has('crate-activity-spinner')).toBe(true);
    expect(indicator?.attributes.get('aria-hidden')).toBe('true');
    expect(element.children[0]?.children).toHaveLength(2);
    expect(element.collectText()).toBe('Uploading 640 of 1,986 files');
});
