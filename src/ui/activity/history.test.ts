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
        expect(container.collectText()).toContain('1 uploaded');
        expect(container.collectText()).toContain('Inbox.md Reminders');
        expect(find(container, 'crate-history-type')).toBeUndefined();
        expect(find(container, 'crate-history-dot')).toBeUndefined();
    });

    it('spells out transfer and deletion counts', () => {
        const container = render({ downloaded: 2, deleted: 3 });
        expect(container.collectText()).toContain('1 uploaded, 2 downloaded, 3 deleted');
    });

    it('retains failure, conflict, and resolved-race information', () => {
        const container = render({
            success: false, errorCount: 2, conflictCount: 1,
            resolvedRaceCount: 1,
            resolvedRaces: [{ path: 'Draft.md', resolution: 'kept-local-edit' }],
        });
        expect(find(container, 'crate-history-entry')?.classNames.has('is-error')).toBe(true);
        expect(container.collectText()).toContain('Failed (2 errors), 1 conflict, 1 race resolved');
        expect(container.collectText()).toContain('Edit/delete race: kept local edit');
    });

    it('does not offer expansion when there are no file details', () => {
        const container = render({ uploaded: 0, uploadedPaths: [], type: 'initial' });
        expect(find(container, 'crate-history-details')).toBeUndefined();
        expect(container.collectText()).toContain('Initial sync');
        expect(container.collectText()).toContain('No changes');
    });
});
