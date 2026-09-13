import type { ReactElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-dom/client', () => ({ createRoot: (element: HTMLElement) => ({
	render: (node: ReactElement<{ onMount: (container: HTMLElement) => void }>) => node.props.onMount(element),
	unmount: vi.fn(),
}) }));
import { FakeElement, MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../test/fakes/obsidian-ui';

vi.mock('obsidian', () => ({ ...createObsidianUiModule(), Platform: { isMobile: false } }));
import { ExclusionPreviewModal } from './exclusion-preview-modal';

afterEach(() => { resetObsidianUiMocks(); vi.restoreAllMocks(); });

it('bounds rendered rows, scrolls to the last file, and searches the entire list', () => {
	let scroll: ((event: Event) => unknown) | undefined;
	vi.spyOn(FakeElement.prototype, 'addEventListener').mockImplementation((type, listener) => {
		if (type === 'scroll') scroll = listener;
	});
	const paths = Array.from({ length: 10000 }, (_, index) => `Archive/note-${index}.md`);
	const modal = new ExclusionPreviewModal({} as never, paths);
	modal.open();
	const content = modal.contentEl as unknown as import('../test/fakes/obsidian-ui').FakeElement;
	expect(content.collectText()).toContain('10000 matching files');
	const list = content.children.find(child => child.classNames.has('crate-exclusion-preview-list'))!;
	expect(list.children).toHaveLength(42);
	expect(content.collectText()).not.toContain('note-9999.md');
	(list as unknown as HTMLElement).scrollTop = 9999 * 58;
	scroll!(new Event('scroll'));
	expect(list.children).toHaveLength(42);
	expect(content.collectText()).toContain('note-9999.md');
	const search = MockSetting.instances[0]!.texts[0]!;
	search.change('NOTE-9999');
	expect(content.collectText()).toContain('1 of 10000 files');
	expect(content.collectText()).toContain('note-9999.md');
	expect(list.children).toHaveLength(3);
	expect((list as unknown as HTMLElement).scrollTop).toBe(0);
	expect(content.collectText()).not.toContain('note-0.md');
	search.change('not-a-match');
	expect(content.collectText()).toContain('No files match your search.');
	search.change('');
	expect(content.collectText()).toContain('10000 matching files');
	modal.close();
	expect(content.collectText()).toBe('');
});
