/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { writeCommittedMarkdownFile } from '../sync/markdown-files';
import { handleListReminders } from './handlers/list';
import { parseProjectPath, parseReminderSourceFilePath } from './requests';

beforeEach(async () => { await applySchema(env.DB); });
afterEach(async () => { await reset(); });

it('keeps archive notes out of the list, its parsed cache and its revision', async () => {
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', '- [ ] Open <!-- crate-id:open -->\n', null);
	const list = () => handleListReminders(new Request('https://worker.test/reminders/list?folderPath=Reminders'), env);
	const before = await list();
	const etag = before.headers.get('ETag')!;
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Archive/Inbox.md', '- [x] Done <!-- crate-id:done -->\n', null);
	const after = await list();
	expect(await after.json()).toMatchObject({ reminders: [{ id: 'open' }], projects: ['Inbox'], issues: [] });
	expect(after.headers.get('ETag')!.split('.')[1]).toBe(etag.split('.')[1]);
	const cached = await env.DB.prepare('SELECT file_path FROM reminder_file_cache').all<{ file_path: string }>();
	expect(cached.results.map(row => row.file_path)).toEqual(['Reminders/Inbox.md']);
});

it('rejects web app commands that target the archive', () => {
	expect(parseReminderSourceFilePath('Reminders/Archive/Inbox.md', 'Reminders')).toBeNull();
	expect(parseReminderSourceFilePath('Reminders/Inbox.md', 'Reminders')).toBe('Reminders/Inbox.md');
	expect(parseProjectPath('Archive/Inbox')).toBeNull();
});
