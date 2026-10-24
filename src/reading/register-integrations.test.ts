import { afterEach, describe, expect, it, vi } from 'vitest';
import type CratePlugin from '../plugin/CratePlugin';
import { registerReading } from './register-integrations';
import { READING_VIEW_TYPE, clearRequestedReadingItem, requestedReadingItem } from './runtime';

vi.mock('./ui/plugin/reading-view', () => ({ ReadingView: class {} }));
vi.mock('./ui/plugin/add-link-modal', () => ({ AddReadingLinkModal: class {} }));
vi.mock('./runtime', async importOriginal => ({ ...await importOriginal<typeof import('./runtime')>(), startReading: vi.fn(), stopReading: vi.fn() }));

const id = '0cf86c65-51e2-4e2b-8987-0a4732473588';

function harness(enabled = true) {
	const handlers = new Map<string, (params: Record<string, string>) => void>();
	const leaf = { setViewState: vi.fn(async () => {}) };
	const triggerForegroundSync = vi.fn();
	const plugin = {
		settings: { reading: { enabled } }, register: vi.fn(), registerView: vi.fn(), addCommand: vi.fn(),
		registerObsidianProtocolHandler: (action: string, handler: (params: Record<string, string>) => void) => { handlers.set(action, handler); },
		syncRuntime: { triggerForegroundSync },
		app: { workspace: { getLeavesOfType: () => [], getLeaf: () => leaf, revealLeaf: vi.fn(async () => {}) } },
	} as unknown as CratePlugin;
	registerReading(plugin);
	return { plugin, leaf, triggerForegroundSync, open: (params: Record<string, string>) => handlers.get('crate-reading')!({ action: 'crate-reading', ...params }) };
}

describe('crate-reading protocol', () => {
	afterEach(() => { vi.useRealTimers(); });

	it('syncs, opens reading and requests the saved article', async () => {
		const { plugin, leaf, triggerForegroundSync, open } = harness();
		open({ item: id.toUpperCase() });
		expect(triggerForegroundSync).toHaveBeenCalledWith('visible');
		await vi.waitFor(() => expect(leaf.setViewState).toHaveBeenCalledWith({ type: READING_VIEW_TYPE, active: true }));
		expect(requestedReadingItem(plugin)).toBe(id);
		clearRequestedReadingItem(plugin);
	});

	it('ignores malformed ids and expires unanswered requests', async () => {
		vi.useFakeTimers();
		const invalid = harness();
		invalid.open({ item: '../note' });
		await vi.waitFor(() => expect(invalid.leaf.setViewState).toHaveBeenCalled());
		expect(requestedReadingItem(invalid.plugin)).toBeUndefined();

		const stale = harness();
		stale.open({ item: id });
		await vi.waitFor(() => expect(stale.leaf.setViewState).toHaveBeenCalled());
		vi.advanceTimersByTime(120_000);
		expect(requestedReadingItem(stale.plugin)).toBeUndefined();
	});

	it('does not request an article while reading is disabled', () => {
		const { plugin, leaf, open } = harness(false);
		open({ item: id });
		expect(leaf.setViewState).not.toHaveBeenCalled();
		expect(requestedReadingItem(plugin)).toBeUndefined();
	});
});
