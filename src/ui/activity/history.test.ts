import { describe, expect, it, vi } from 'vitest';
import { FakeElement } from '../../test/fakes/obsidian-ui';
import type { SyncHistoryEntry } from '../../sync/types';
import { renderHistoryPanel } from './history';

vi.mock('obsidian', () => ({ setIcon: vi.fn() }));

const entry: SyncHistoryEntry = {
    timestamp: '2026-09-03T22:01:00Z', type: 'sync', success: true,
    uploaded: 1, downloaded: 0, merged: 0, deleted: 0,
    errorCount: 0, conflictCount: 0, uploadedPaths: ['Reminders/Inbox.md'],
};

function render(overrides: Partial<SyncHistoryEntry> = {}) {
    const container = new FakeElement('div');
    renderHistoryPanel(container as unknown as HTMLElement, [{ ...entry, ...overrides }]);
    return container;
}

function find(element: FakeElement, className: string): FakeElement | undefined {
    if (element.classNames.has(className)) return element;
    for (const child of element.children) {
        const match = find(child, className);
        if (match) return match;
    }
    return undefined;
}

describe('activity history', () => {
    it('keeps a sync summary and its files in one native disclosure', () => {
        const container = render({ uploaded: 2, uploadedPaths: ['Reminders/Inbox.md', 'Notes/Plan.md'] });
        const details = find(container, 'crate-history-details');
        expect(details?.tagName).toBe('details');
        expect(details?.children[0]?.tagName).toBe('summary');
        expect(details?.children[1]?.classNames.has('crate-history-files')).toBe(true);
        expect(container.collectText()).toContain('Uploaded 2 files');
        expect(container.collectText()).toContain('Inbox.md Reminders');
        expect(find(container, 'crate-history-type')).toBeUndefined();
        expect(find(container, 'crate-history-dot')).toBeUndefined();
    });

    it('uses the same secondary action style as conflict review', () => {
        const container = new FakeElement('div');
        renderHistoryPanel(container as unknown as HTMLElement, [entry], vi.fn());
        const button = find(container, 'crate-file-history-link');
        expect(button?.tagName).toBe('button');
        expect(button?.classNames.has('crate-activity-action')).toBe(true);
    });

    it('shows plugin uploads and their configuration folder paths', () => {
        const uploadedPaths = Array.from({ length: 53 }, (_, index) => `.obsidian/plugins/plugin-${index}/data.json`);
        const container = render({ uploaded: 53, uploadedPaths });
        expect(container.collectText()).toContain('Uploaded 53 files');
        expect(container.collectText()).not.toContain('No changes');
        for (const path of uploadedPaths) {
            expect(container.collectText()).toContain(`data.json ${path.slice(0, path.lastIndexOf('/'))}`);
        }
        expect(find(container, 'crate-history-details')).toBeDefined();
    });

    it('shows errors even when no files transferred', () => {
        const container = render({ success: false, uploaded: 0, uploadedPaths: [], errorCount: 1, errors: ['Upload failed: Notes.md'] });
        expect(find(container, 'crate-history-details')).toBeDefined();
        expect(container.collectText()).toContain('Upload failed: Notes.md');
    });

    it('explains missing details in older history entries', () => {
        const container = render({ success: false, uploadedPaths: [], errorCount: 1 });
        expect(container.collectText()).toContain('Error details were not saved');
    });

    it('spells out transfer and deletion counts', () => {
        const container = render({ downloaded: 2, deleted: 3 });
        expect(container.collectText()).toContain('Uploaded 1 · Downloaded 2 · Deleted 3');
    });

    it('retains failure, conflict, and resolved-race information', () => {
        const container = render({
            success: false, errorCount: 2, conflictCount: 1,
            resolvedRaceCount: 1,
            resolvedRaces: [{ path: 'Draft.md', resolution: 'kept-local-edit' }],
        });
        expect(find(container, 'crate-history-entry')?.classNames.has('is-error')).toBe(true);
        expect(container.collectText()).toContain('Failed (2 errors) Uploaded 1 · 1 conflict · 1 race resolved');
        expect(container.collectText()).toContain('Edit/delete race: kept local edit');
    });

    it('does not offer expansion when there are no file details', () => {
        const container = render({ uploaded: 0, uploadedPaths: [], type: 'initial' });
        expect(find(container, 'crate-history-details')).toBeUndefined();
        expect(container.collectText()).toContain('Initial sync');
        expect(container.collectText()).toContain('No changes');
    });
});

it('does not expose saved timing diagnostics in history', () => {
  const element = render({ uploaded: 0, uploadedPaths: [], timings: {
    totalMs: 2000, phases: { scanning: 1500, saving: 500 },
  } });
  expect(element.collectText()).not.toContain('Timing details');
  expect(find(element, 'crate-history-details')).toBeUndefined();
});

it('renders a collapsed no-change row with its latest time', () => {
    const container = new FakeElement('div');
    const history = [14, 13, 12].map(hour => ({ ...entry, uploaded: 0, uploadedPaths: [],
        timestamp: new Date(2026, 8, 19, hour, 15).toISOString() }));
    renderHistoryPanel(container as unknown as HTMLElement, history);
    expect(container.collectText()).toContain('No changes · 3 checks');
    expect(find(container, 'crate-history-time')?.collectText()).toBe('14:15:00');
    expect(find(container, 'crate-history-details')).toBeUndefined();
});

it('keeps single-file successes expandable with a summary and file row', () => {
    const container = render();
    expect(container.collectText()).toContain('Uploaded 1 file');
    expect(container.collectText()).toContain('Inbox.md Reminders');
    expect(find(container, 'crate-history-details')).toBeDefined();
    expect(find(container, 'crate-history-files')).toBeDefined();
});
it('keeps single-file failures expandable', () => {
    const container = render({ success: false, errorCount: 1, errors: ['Failed to finish'] });
    expect(find(container, 'crate-history-details')).toBeDefined();
    expect(container.collectText()).toContain('Failed to finish');
});

it('offers a checkpoint restore independently of truncated file lists', () => {
    const container = new FakeElement('div');
    renderHistoryPanel(container as unknown as HTMLElement, [{ ...entry, uploaded: 400, uploadedPaths: [], historyCheckpoint: 'a'.repeat(64) }], undefined, vi.fn());
    expect(find(container, 'crate-history-details')).toBeDefined();
    expect(container.collectText()).toContain('Review restore point');
});

it('explains why older entries cannot restore the whole vault', () => {
    const container = new FakeElement('div');
    renderHistoryPanel(container as unknown as HTMLElement, [entry], undefined, vi.fn());
    expect(container.collectText()).toContain('This entry has no available vault checkpoint');
    expect(container.collectText()).not.toContain('Review restore point');
});


it('identifies same-minute restore points and exposes review without expanding file lists', () => {
    const container = new FakeElement('div');
    renderHistoryPanel(container as unknown as HTMLElement, [
        { ...entry, timestamp: '2026-09-20T10:18:42Z', sharedCheckpoint: '12345678-1234-1234-1234-123456789012' },
        { ...entry, timestamp: '2026-09-20T10:18:07Z', historyCheckpoint: 'b'.repeat(64) },
    ], undefined, vi.fn());
    const timeline = find(container, 'crate-activity-timeline')!;
    const rows = timeline.children[0]!.children.slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.collectText()).not.toContain('Restore point 12345678');
    expect(rows[1]!.collectText()).not.toContain('Restore point bbbbbbbb');
    expect(find(rows[0]!, 'crate-history-header')?.collectText()).not.toContain('Inbox.md');
    expect(find(rows[0]!, 'crate-history-files')?.collectText()).toContain('Inbox.md');
    expect(find(rows[0]!, 'crate-history-time')?.collectText()).toMatch(/:18:42$/);
    expect(find(rows[1]!, 'crate-history-time')?.collectText()).toMatch(/:18:07$/);
    for (const row of rows) {
        expect(row.children.some(child => child.classNames.has('crate-history-state-actions'))).toBe(true);
    }
});
