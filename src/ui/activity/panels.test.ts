import { afterEach, expect, it, vi } from 'vitest';
import { FakeElement, createObsidianUiModule } from '../../test/fakes/obsidian-ui';

vi.mock('obsidian', () => createObsidianUiModule());
import { renderPendingPanel } from './panels';

afterEach(() => vi.clearAllMocks());

it('shows active initial upload with an empty pending queue', () => {
    const element = new FakeElement('div');
    renderPendingPanel(element as never, [], false, false, { type: 'initial', current: 12, total: 20 });
    expect(element.collectText()).toContain('Uploading your vault');
    expect(element.collectText()).toContain('12 of 20 files prepared for upload');
    expect(element.collectText()).not.toContain('All synced');
});

it('does not claim completion before transfer progress is available', () => {
    const element = new FakeElement('div');
    renderPendingPanel(element as never, [], false, true);
    expect(element.collectText()).toContain('Syncing files');
    expect(element.collectText()).not.toContain('All synced');
});

it('shows the normal empty state after syncing finishes', () => {
    const element = new FakeElement('div');
    renderPendingPanel(element as never, []);
    expect(element.collectText()).toContain('All synced');
});
