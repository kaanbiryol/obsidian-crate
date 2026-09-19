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
        const container = render();
        const details = find(container, 'crate-history-details');
        expect(details?.tagName).toBe('details');
        expect(details?.children[0]?.tagName).toBe('summary');
        expect(details?.children[1]?.classNames.has('crate-history-files')).toBe(true);
        expect(container.collectText()).toContain('1 file uploaded');
        expect(container.collectText()).toContain('Inbox.md Reminders');
        expect(find(container, 'crate-history-type')).toBeUndefined();
        expect(find(container, 'crate-history-dot')).toBeUndefined();
    });

    it('shows plugin uploads and their configuration folder paths', () => {
        const uploadedPaths = Array.from({ length: 53 }, (_, index) => `.obsidian/plugins/plugin-${index}/data.json`);
        const container = render({ uploaded: 53, uploadedPaths });
        expect(container.collectText()).toContain('53 uploaded');
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
        expect(container.collectText()).toContain('1 uploaded · 2 downloaded · 3 deleted');
    });

    it('retains failure, conflict, and resolved-race information', () => {
        const container = render({
            success: false, errorCount: 2, conflictCount: 1,
            resolvedRaceCount: 1,
            resolvedRaces: [{ path: 'Draft.md', resolution: 'kept-local-edit' }],
        });
        expect(find(container, 'crate-history-entry')?.classNames.has('is-error')).toBe(true);
        expect(container.collectText()).toContain('Failed (2 errors) 1 uploaded · 1 conflict · 1 race resolved');
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
    expect(find(container, 'crate-history-time')?.collectText()).toBe('14:15');
    expect(find(container, 'crate-history-details')).toBeUndefined();
});
