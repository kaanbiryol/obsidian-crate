import { beforeEach, describe, expect, it, vi } from 'vitest';

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

class FakeElement {
    readonly children: FakeElement[] = [];
    readonly listeners = new Map<string, Array<(event: Event) => void>>();
    className = '';
    textContent = '';
    checked = false;
    indeterminate = false;
    disabled = false;
    constructor(readonly tag: string, options: { cls?: string } = {}) { this.className = options.cls ?? ''; }
    createEl(tag: string, options: { cls?: string } = {}) { const child = new FakeElement(tag, options); this.children.push(child); return child; }
    createDiv(options: { cls?: string } = {}) { return this.createEl('div', options); }
    createSpan(options: { cls?: string } = {}) { return this.createEl('span', options); }
    prepend(child: FakeElement) { this.children.unshift(child); }
    setAttribute() {}
    addEventListener(type: string, listener: (event: Event) => void) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
    getBoundingClientRect() { return { right: 300, bottom: 120 }; }
    click() { for (const listener of this.listeners.get('click') ?? []) listener({ stopPropagation() {} } as Event); }
}

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
        const button = row.children.find(child => child.className === 'crate-browser-file-menu');
        expect(button).toBeDefined();

        button!.click();

        expect(obsidian.shown).toEqual([{ x: 300, y: 120, titles: ['Discard 1 item…'] }]);
    });

    it('keeps desktop rows on the context menu only', () => {
        obsidian.isMobile = false;
        const { row } = setup();
        expect(row.children).toHaveLength(0);
    });
});
