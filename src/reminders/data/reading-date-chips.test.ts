import { DOMParser } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkdownPostProcessorContext } from 'obsidian';
import { createReadingDateChips } from './reading-date-chips';

const source = [
	'- [ ] Book a table 2026-11-20T09:30:00.000Z <!-- crate-id:a -->',
	'\t- [ ] Nested 2026-11-21 <!-- crate-id:b -->',
	'- [ ] Plain task',
].join('\n');

let document: Document;
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-11-14T12:00:00.000Z'));
	document = new DOMParser().parseFromString('<html><body></body></html>', 'text/html') as unknown as Document;
	vi.stubGlobal('NodeFilter', { SHOW_TEXT: 4 });
	vi.stubGlobal('createSpan', ({ cls, text, attr }: { cls: string[]; text: string; attr: Record<string, string> }) => {
		const span = document.createElement('span');
		span.className = cls.join(' ');
		span.textContent = text;
		for (const [name, value] of Object.entries(attr)) span.setAttribute(name, value);
		return span;
	});
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function render(isReminderFile = true) {
	const html = '<div><ul><li class="task-list-item" data-line="0">Book a table 2026-11-20T09:30:00.000Z'
		+ '<ul><li class="task-list-item" data-line="1">Nested 2026-11-21</li></ul></li>'
		+ '<li class="task-list-item" data-line="2">Plain task</li></ul></div>';
	document = new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'text/html') as unknown as Document;
	const section = document.body.firstElementChild as HTMLElement;
	const open = vi.fn();
	const context = { sourcePath: 'Tasks.md', getSectionInfo: () => ({ text: source, lineStart: 0, lineEnd: 2 }) } as unknown as MarkdownPostProcessorContext;
	createReadingDateChips(() => isReminderFile, open)(section, context);
	return { section, open };
}

describe('reminder dates in reading view', () => {
	it('replaces each task’s stored date with a chip that opens its reminder', () => {
		const { section, open } = render();
		const chips = [...section.querySelectorAll('.crate-reminder-date')];
		expect(chips).toHaveLength(2);
		expect(section.textContent).not.toContain('2026-11-20T09:30:00.000Z');
		expect(chips[1]!.closest('li')!.getAttribute('data-line')).toBe('1');
		chips[0]!.dispatchEvent(new (section.ownerDocument.defaultView as unknown as typeof globalThis).Event('click'));
		expect(open).toHaveBeenCalledWith('a');
	});

	it('leaves notes outside the reminder index alone', () => {
		expect(render(false).section.querySelector('.crate-reminder-date')).toBeNull();
	});
});
