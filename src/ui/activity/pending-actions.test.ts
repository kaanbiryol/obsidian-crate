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

function setup() {
	const key = 'Notes/Today.md';
	const rows = { contextTargets: vi.fn(() => [key]) };
	const actions = { syncSelected: vi.fn(), discard: vi.fn() };
	const selection = createPendingActions(
		new FakeElement('div') as never, new FakeElement('div') as never, [key], new Set(), actions, rows as never,
	);
	const row = new FakeElement('div');
	selection.addMenuButton(row as never, key);
	return { row };
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
});
