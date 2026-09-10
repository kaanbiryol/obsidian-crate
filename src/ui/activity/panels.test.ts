import { afterEach, expect, it, vi } from 'vitest';
import { FakeElement, createObsidianUiModule } from '../../test/fakes/obsidian-ui';

vi.mock('obsidian', () => createObsidianUiModule());
import { renderConflictsPanel, renderPendingPanel } from './panels';

afterEach(() => vi.clearAllMocks());

it('shows active initial upload with an empty pending queue', () => {
    const element = new FakeElement('div');
    renderPendingPanel(element as never, [], false, false, { type: 'initial', current: 12, total: 20 });
    expect(element.collectText()).toContain('Uploading vault');
    expect(element.children[0]?.attributes.get('role')).toBe('status');
    expect(element.collectText()).not.toContain('All synced');
});

it('does not claim completion before transfer progress is available', () => {
    const element = new FakeElement('div');
    renderPendingPanel(element as never, [], false, true);
    expect(element.collectText()).toContain('Syncing…');
    expect(element.collectText()).not.toContain('All synced');
});

it('shows the normal empty state after syncing finishes', () => {
    const element = new FakeElement('div');
    renderPendingPanel(element as never, [], false, false, null, 'Synced just now');
    expect(element.collectText()).toContain('All synced');
    expect(element.collectText()).toContain('Synced just now');
    expect(element.collectText()).not.toContain('Your vault is up to date.');
});

it('replaces the pending file list with a loading indicator during sync', () => {
    const element = new FakeElement('div');
    renderPendingPanel(element as never, ['Notes/draft.md', 'delete:old.md'], false, true);
    expect(element.collectText()).toBe('Syncing…');
    expect(element.children[0]?.classNames.has('crate-activity-loading')).toBe(true);
    expect(element.children[0]?.children[0]?.attributes.get('aria-hidden')).toBe('true');

    element.empty();
    renderPendingPanel(element as never, ['Notes/draft.md']);
    expect(element.collectText()).toContain('draft.md');
    expect(element.collectText()).not.toContain('Syncing…');
});

it.each(['Synced just now', 'Syncing…', 'Last sync had errors'])(
    'shows the current sync status beneath No conflicts: %s',
    (status) => {
        const element = new FakeElement('div');
        renderConflictsPanel(element as never, [], status);
        expect(element.collectText()).toBe(`No conflicts ${status}`);
    },
);
