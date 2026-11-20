import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeElement } from '../../test/fakes/obsidian-ui';

const obsidian = vi.hoisted(() => ({ isMobile: false, shown: [] as Array<{ x: number; y: number; titles: string[] }> }));

vi.mock('obsidian', () => {
	class Menu {
		titles: string[] = [];
		addItem(callback: (item: unknown) => void) {
			const item = {
				setTitle: (title: string) => { this.titles.push(title); return item; },
				setIcon: () => item, setDisabled: () => item, onClick: () => item,
			};
			callback(item);
			return this;
		}
		addSeparator() { return this; }
		showAtPosition(position: { x: number; y: number }) { obsidian.shown.push({ ...position, titles: this.titles }); }
		showAtMouseEvent() {}
	}
	return {
		Menu, Notice: class {}, setIcon: () => {},
		Platform: { get isMobile() { return obsidian.isMobile; } },
	};
});

const { createPendingActions } = await import('./pending-actions');
const { groupPendingItems } = await import('./pending-items');
const { pendingChangeKey } = await import('../../sync/pending/pending-change');

function setup() {
	const key = 'Notes/Today.md';
	const rows = { contextTargets: vi.fn(() => [key]) };
	const actions = { sync: { describe: () => ({ label: 'Sync', disabled: false, idle: true }), run: vi.fn() }, discard: vi.fn() };
	const selection = createPendingActions(
		new FakeElement('div') as never, new FakeElement('div') as never, groupPendingItems([key]), new Set(), actions, rows as never,
	);
	const row = new FakeElement('div');
	selection.addMenuButton(row as never, key);
	return { row };
}

function setupSelection(automaticSync: boolean) {
	const keys = ['Notes/Today.md', 'Notes/Draft.md'];
	const sidebar = new FakeElement('div'), heading = new FakeElement('div');
	const actions = { sync: { describe: () => ({ label: 'Sync', disabled: false, idle: true }), run: vi.fn() }, discard: vi.fn(), automaticSync };
	const items = groupPendingItems(keys);
	const selection = createPendingActions(sidebar as never, heading as never, items, new Set([keys[1]!]), actions, { contextTargets: () => [] } as never);
	const row = new FakeElement('div');
	selection.addCheckbox(row as never, items[0]!);
	const button = sidebar.querySelector('.crate-browser-sync')!;
	return { selection, heading, row, button, run: actions.sync.run };
}

describe('pending change actions', () => {
	beforeEach(() => { obsidian.shown.length = 0; });

	it('opens the row menu from a visible button on mobile', () => {
		obsidian.isMobile = true;
		const { row } = setup();
		const button = row.children.find(child => child.classNames.has('crate-browser-file-menu'));
		expect(button).toBeDefined();
		Object.assign(button!, { getBoundingClientRect: () => ({ right: 300, bottom: 120 }) });

		button!.dispatchEvent(new Event('click'));

		expect(obsidian.shown).toEqual([{ x: 300, y: 120, titles: ['Discard 1 item…'] }]);
	});

	it('keeps desktop rows on the context menu only', () => {
		obsidian.isMobile = false;
		const { row } = setup();
		expect(row.children).toHaveLength(0);
	});

	it('lets manual sync hold unchecked files', () => {
		const { selection, heading, row, button, run } = setupSelection(false);
		expect(selection.checkable).toBe(true);
		expect(heading.querySelector('.crate-browser-select-all')).not.toBeNull();
		expect(row.querySelector('.crate-browser-file-check')).not.toBeNull();
		expect(button.collectText()).toContain('Sync 1 file');

		button.dispatchEvent(new Event('click'));

		expect(run).toHaveBeenCalledWith(['Notes/Draft.md']);
	});

	it('drops checkboxes under automatic sync, which uploads every pending file', () => {
		const { selection, heading, row, button, run } = setupSelection(true);
		expect(selection.checkable).toBe(false);
		expect(heading.querySelector('.crate-browser-select-all')).toBeNull();
		expect(heading.collectText()).toContain('Changes sync automatically');
		expect(row.children).toHaveLength(0);
		expect(button.collectText()).toContain('Sync now');

		button.dispatchEvent(new Event('click'));

		// A selection left from before automatic sync was on holds nothing back.
		expect(run).toHaveBeenCalledWith([]);
	});

	it('checks, counts and holds back a plugin row as one item covering all of its code files', () => {
		const plugin = ['.obsidian/plugins/dataview/main.js', '.obsidian/plugins/dataview/manifest.json', pendingChangeKey('delete', '.obsidian/plugins/dataview/styles.css')];
		const items = groupPendingItems([...plugin, 'Notes/Today.md'], '.obsidian');
		const sidebar = new FakeElement('div'), heading = new FakeElement('div');
		const discard = vi.fn();
		const actions = { sync: { describe: () => ({ label: 'Sync', disabled: false, idle: true }), run: vi.fn() }, discard };
		const selection = createPendingActions(sidebar as never, heading as never, items, new Set(), actions, { contextTargets: () => [items[0]!.key] } as never);
		const row = new FakeElement('div');
		selection.addCheckbox(row as never, items[0]!);
		const button = sidebar.querySelector('.crate-browser-sync')!;
		expect(button.collectText()).toContain('Sync 2 items');
		expect(heading.collectText()).toContain('2 of 2 items selected');

		const input = row.querySelector('input') as unknown as { checked: boolean; dispatchEvent(event: Event): void };
		input.checked = false;
		input.dispatchEvent(new Event('change'));
		expect(button.collectText()).toContain('Sync 1 item');
		button.dispatchEvent(new Event('click'));
		expect(actions.sync.run).toHaveBeenCalledWith(plugin);

		obsidian.isMobile = true;
		const menuRow = new FakeElement('div');
		selection.addMenuButton(menuRow as never, items[0]!.key);
		const menu = menuRow.children.find(child => child.classNames.has('crate-browser-file-menu'))!;
		Object.assign(menu, { getBoundingClientRect: () => ({ right: 0, bottom: 0 }) });
		menu.dispatchEvent(new Event('click'));
		expect(obsidian.shown.at(-1)?.titles).toEqual(['Discard 1 item…']);
	});
});
