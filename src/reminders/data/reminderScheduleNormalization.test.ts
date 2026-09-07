import { afterEach, expect, it, vi } from 'vitest';
import { resetLocalTimeZone } from '@internationalized/date';
import { createMockAppWithVault } from '@/test/factories/obsidian';
import { createReminderIndex } from './reminder-index';
import { TFile } from 'obsidian';

const originalZone = process.env.TZ;
afterEach(() => { process.env.TZ = originalZone; resetLocalTimeZone(); vi.useRealTimers(); });

it('adopts and migrates relative schedules through the real scanner/index once', async () => {
	process.env.TZ = 'UTC'; resetLocalTimeZone();
	vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-08T10:00:00Z'));
	const path = 'Reminders/Inbox.md';
	const { app, files } = createMockAppWithVault({ [path]: '- [ ] Send invoice tomorrow <!-- crate-id:invoice -->\n<!-- crate-desc:v1:Details -->\n' });
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) throw new Error('Missing fixture');
	const index = createReminderIndex(app, 'Reminders');
	await index.rescanFile(file, true);
	const persisted = files.get(path)!;
	expect(persisted).toContain('Send invoice 2026-09-09');
	expect(index.getById('invoice')).toMatchObject({ dueDate: '2026-09-09', description: 'Details' });
	process.env.TZ = 'Pacific/Honolulu'; resetLocalTimeZone();
	vi.setSystemTime(new Date('2026-09-09T10:00:00Z'));
	await index.rescanFile(file, true);
	expect(files.get(path)).toBe(persisted);
	expect(index.getById('invoice')?.dueDate).toBe('2026-09-09');
	files.set(path, persisted.replace('2026-09-09', 'tomorrow'));
	await index.rescanFile(file, true);
	expect(index.getById('invoice')?.dueDate).toBe('2026-09-10');
});
