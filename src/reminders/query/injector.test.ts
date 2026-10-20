import { afterEach, expect, it, vi } from 'vitest';
import type { MarkdownPostProcessorContext, MarkdownSectionInformation } from 'obsidian';
import type CratePlugin from '@/main';
import { Notice } from '@/test/mocks/obsidian';
import { createReminderByteVault } from '@/test/factories/reminder-byte-vault';

vi.mock('obsidian', async importOriginal => ({
	...await importOriginal<typeof import('obsidian')>(),
	MarkdownRenderChild: class { constructor(readonly containerEl: unknown) {} },
}));
vi.mock('@/reminders/ui/plugin/reminder-list/RemindersList', () => ({ RemindersList: () => null }));
import { ReminderQueryInjector } from './injector';

type ListProps = { showCompleted?: boolean; onToggleShowCompleted?: (value: boolean) => void };

const path = 'Notes/Plan.md';
const note = ['# Plan', '```reminders', 'project: Work', '```', 'After the block'].join('\n');
const fixtures: Awaited<ReturnType<typeof createReminderByteVault>>[] = [];
afterEach(async () => {
	Notice.reset();
	for (const h of fixtures.splice(0)) await h.dispose();
});

async function render(content = note, section: () => MarkdownSectionInformation | null = () => ({ text: content, lineStart: 1, lineEnd: 3 })) {
	const h = await createReminderByteVault({ [path]: content });
	fixtures.push(h);
	const plugin = { app: h.app, remindersSettings: {} } as unknown as CratePlugin;
	let props: ListProps | undefined;
	const ctx = {
		sourcePath: path,
		getSectionInfo: section,
		addChild: (child: { props: ListProps }) => { props = child.props; },
	} as unknown as MarkdownPostProcessorContext;
	const source = content.split('\n').slice(2, content.split('\n').indexOf('```', 2)).join('\n');
	new ReminderQueryInjector(plugin).onBlock('reminders', source, {} as HTMLElement, ctx);
	return { h, props: props! };
}

it('reads the initial state from the block and writes the toggle into the note', async () => {
	const { h, props } = await render();
	expect(props.showCompleted).toBe(false);
	props.onToggleShowCompleted!(true);
	await vi.waitFor(async () => expect((await h.readBytes(path)).toString()).toBe(
		['# Plan', '```reminders', 'project: Work', 'show-completed: true', '```', 'After the block'].join('\n'),
	));
});

it('starts from a saved show-completed option', async () => {
	const content = ['# Plan', '```reminders', 'show-completed: true', '```'].join('\n');
	const { props } = await render(content);
	expect(props.showCompleted).toBe(true);
});

it('does not rewrite the note when the block changed after it was rendered', async () => {
	const { h, props } = await render();
	const edited = note.replace('project: Work', 'project: Home');
	await h.put(path, edited);
	props.onToggleShowCompleted!(true);
	await vi.waitFor(() => expect(Notice.messages).toEqual(['Failed to save reminder view preference: This reminders block changed. Try again.']));
	expect((await h.readBytes(path)).toString()).toBe(edited);
});

it('keeps the toggle local when the block has no section in a note', async () => {
	const { props } = await render(note, () => null);
	expect(props.onToggleShowCompleted).toBeUndefined();
});
