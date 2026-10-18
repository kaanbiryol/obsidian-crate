import { expect, it, vi } from 'vitest';
import { TFile, TFolder, type App } from 'obsidian';
import { createReminderIndex } from './reminder-index';
import { parseReminderContent } from '@/reminders/utils/reminderParser';

// Count the date-parsing step that dominates scan cost, without changing it.
vi.mock('@/reminders/utils/reminderParser', async importOriginal => {
	const actual = await importOriginal<typeof import('@/reminders/utils/reminderParser')>();
	return { ...actual, parseReminderContent: vi.fn(actual.parseReminderContent) };
});

function file(path: string): TFile {
	return Object.assign(new TFile(), { path, name: 'Inbox.md', basename: 'Inbox', extension: 'md', parent: null, vault: {}, stat: { ctime: 0, mtime: 0, size: 0 } });
}

it('parses each reminder line twice when a toggle rescans its note', async () => {
	const lines = Array.from({ length: 50 }, (_, i) => `- [ ] Task ${i} Nov 20, 2026 <!-- crate-id:rem-${i} -->`);
	let content = lines.join('\n');
	const inbox = file('Reminders/Inbox.md');
	const process = vi.fn(async (_file: TFile, update: (current: string) => string) => (content = update(content)));
	const app = { vault: {
		read: vi.fn(async () => content),
		process,
		adapter: { readBinary: async () => new TextEncoder().encode(content).buffer },
		getAbstractFileByPath: (path: string) => path === inbox.path ? inbox : Object.assign(new TFolder(), { path: 'Reminders', children: [inbox] }),
	} } as unknown as App;
	const index = createReminderIndex(app, 'Reminders');
	await index.load();
	expect(index.getAll()).toHaveLength(50);
	expect(process).not.toHaveBeenCalled();

	content = content.replace('- [ ] Task 7', '- [x] Task 7');
	vi.mocked(parseReminderContent).mockClear();
	await index.rescanFile(inbox);

	expect(index.getAll().find(reminder => reminder.id === 'rem-7')?.completed).toBe(true);
	// Before: 5 per line, including the scan's own pass and an unused content
	// hash. Now the scan reuses the normalization pass.
	expect(vi.mocked(parseReminderContent).mock.calls.length).toBe(2 * lines.length);
});
