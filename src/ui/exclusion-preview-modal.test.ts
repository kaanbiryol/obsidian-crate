import { afterEach, expect, it, vi } from 'vitest';
import { MockSetting, createObsidianUiModule, resetObsidianUiMocks } from '../test/fakes/obsidian-ui';

vi.mock('obsidian', () => createObsidianUiModule());
import { ExclusionPreviewModal } from './exclusion-preview-modal';

afterEach(resetObsidianUiMocks);

it('shows every match beyond 100 and searches the entire list', () => {
	const paths = Array.from({ length: 250 }, (_, index) => `Archive/note-${index}.md`);
	const modal = new ExclusionPreviewModal({} as never, paths);
	modal.open();
	const content = modal.contentEl as unknown as import('../test/fakes/obsidian-ui').FakeElement;
	expect(content.collectText()).toContain('250 matching files');
	expect(content.collectText()).toContain('Archive/note-249.md');
	const search = MockSetting.instances[0]!.texts[0]!;
	search.change('NOTE-249');
	expect(content.collectText()).toContain('1 of 250 files');
	expect(content.collectText()).not.toContain('Archive/note-0.md');
	search.change('not-a-match');
	expect(content.collectText()).toContain('No files match your search.');
	search.change('');
	expect(content.collectText()).toContain('250 matching files');
	modal.close();
	expect(content.collectText()).toBe('');
});
