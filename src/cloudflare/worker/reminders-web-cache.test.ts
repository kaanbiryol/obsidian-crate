import { describe, expect, it, vi } from 'vitest';
import { handleListReminders } from './reminders-web/routes/list';
import { saveReminderFileCache } from './reminders-web/reminder-cache';
import { scanReminderMarkdownFile } from './reminders-web/scan';
import { createEnv } from './reminders-web-test-harness';

describe('reminders web handlers', () => {
it('lists reminders from markdown files in the configured folder', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] First task <!-- crate-id:r1 -->\n- [x] Done task <!-- crate-id:r2 -->\n',
			},
			files: {
				'Reminders/Inbox.md': null,
			},
		});

		const response = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);

		expect(response.status).toBe(200);
		const result = await response.json() as { reminders: Array<{ id: string }>; projects: string[] };
		expect(result.reminders.map((reminder) => reminder.id)).toEqual(['r1', 'r2']);
		expect(result.projects).toEqual(['Inbox']);
		expect(result.reminders[0]).not.toHaveProperty('projectColor');
	});

	it('warms a cold reminder index across bounded requests', async () => {
		const bucketEntries: Record<string, string> = {};
		const files: Record<string, null> = {};
		for (let index = 0; index < 25; index += 1) {
			const path = `Reminders/Project-${String(index).padStart(2, '0')}.md`;
			bucketEntries[`files/${path}`] = `# Project ${index}\n\n- [ ] Task ${index} <!-- crate-id:r-${index} -->\n`;
			files[path] = null;
		}
		const workspace = await createEnv({ bucketEntries, files });
		const bucketGet = workspace.env.BUCKET.get as ReturnType<typeof vi.fn>;
		const dbBatch = workspace.env.DB.batch as ReturnType<typeof vi.fn>;

		const warmingResponse = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		expect(warmingResponse.status).toBe(202);
		expect(await warmingResponse.json()).toEqual({ warming: true, remainingFiles: 5, totalFiles: 25 });
		expect(warmingResponse.headers.get('Retry-After')).toBe('1');
		expect(bucketGet).toHaveBeenCalledTimes(20);

		const readyResponse = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		expect(readyResponse.status).toBe(200);
		const result = await readyResponse.json() as { reminders: Array<{ id: string }> };
		expect(result.reminders).toHaveLength(25);
		expect(bucketGet).toHaveBeenCalledTimes(25);
		expect(Math.max(...dbBatch.mock.calls.map(call => (call[0] as unknown[]).length))).toBeLessThanOrEqual(20);
	});

	it('keeps healthy files available and reports uncacheable parsed reminder data', async () => {
		const oversizedContent = Array.from(
			{ length: 12_000 },
			(_, index) => `- [ ] Task ${index} <!-- crate-id:r-${index} -->`,
		).join('\n');
		expect(new TextEncoder().encode(oversizedContent).byteLength).toBeLessThan(1024 * 1024);
		const bucketEntries: Record<string, string> = {
			'files/Reminders/00-Oversized.md': oversizedContent,
		};
		const files: Record<string, null> = { 'Reminders/00-Oversized.md': null };
		for (let index = 0; index < 20; index += 1) {
			const path = `Reminders/Project-${String(index).padStart(2, '0')}.md`;
			bucketEntries[`files/${path}`] = `- [ ] Task ${index} <!-- crate-id:small-${index} -->`;
			files[path] = null;
		}
		const workspace = await createEnv({ bucketEntries, files });

		const response = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);

    expect(response.status).toBe(202);
    const ready = await handleListReminders(new Request('https://worker.test/reminders/list?folderPath=Reminders'), workspace.env as never);
    expect(ready.status).toBe(200);
    const data = await ready.json() as { reminders: unknown[]; issues: Array<{ path: string }> };
    expect(data.reminders).toHaveLength(20);
    expect(data.issues).toMatchObject([{ path: 'Reminders/00-Oversized.md' }]);
    const reads = (workspace.env.BUCKET.get as ReturnType<typeof vi.fn>).mock.calls.length;
    expect((await handleListReminders(new Request('https://worker.test/reminders/list?folderPath=Reminders'), workspace.env as never)).status).toBe(200);
    expect(workspace.env.BUCKET.get).toHaveBeenCalledTimes(reads);
	});

	it('returns 304 from file metadata without reading markdown objects again', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] First task <!-- crate-id:r1 -->\n',
				'files/Reminders/Work.md': '# Work\n\n- [ ] Second task <!-- crate-id:r2 -->\n',
			},
			files: {
				'Reminders/Inbox.md': null,
				'Reminders/Work.md': null,
			},
		});
		const bucketGet = workspace.env.BUCKET.get as ReturnType<typeof vi.fn>;
		const firstResponse = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		const etag = firstResponse.headers.get('ETag');
		expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
		expect(bucketGet).toHaveBeenCalledTimes(2);

		const secondResponse = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders', {
				headers: { 'If-None-Match': etag ?? '' },
			}),
			workspace.env as never,
		);

		expect(secondResponse.status).toBe(304);
		expect(bucketGet).toHaveBeenCalledTimes(2);
	});

	it('reuses cached parses when the client requests a full response again', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] First task <!-- crate-id:r1 -->\n',
				'files/Reminders/Work.md': '# Work\n\n- [ ] Second task <!-- crate-id:r2 -->\n',
			},
			files: {
				'Reminders/Inbox.md': null,
				'Reminders/Work.md': null,
			},
		});
		const bucketGet = workspace.env.BUCKET.get as ReturnType<typeof vi.fn>;

		await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		const response = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);

		expect(response.status).toBe(200);
		expect(bucketGet).toHaveBeenCalledTimes(2);
		const result = await response.json() as { reminders: Array<{ id: string }> };
		expect(result.reminders.map((reminder) => reminder.id)).toEqual(['r1', 'r2']);
	});

	it('reads and reparses only the file whose hash changed', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] First task <!-- crate-id:r1 -->\n',
				'files/Reminders/Work.md': '# Work\n\n- [ ] Second task <!-- crate-id:r2 -->\n',
			},
			files: {
				'Reminders/Inbox.md': null,
				'Reminders/Work.md': null,
			},
		});
		const bucketGet = workspace.env.BUCKET.get as ReturnType<typeof vi.fn>;

		await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		await workspace.replaceCurrentFile(
			'Reminders/Work.md',
			'# Work\n\n- [ ] Updated task <!-- crate-id:r2 -->\n- [ ] Added task <!-- crate-id:r3 -->\n',
		);
		const response = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);

		expect(bucketGet).toHaveBeenCalledTimes(3);
		const result = await response.json() as { reminders: Array<{ id: string; content: string }> };
		expect(result.reminders).toMatchObject([
			{ id: 'r1', content: 'First task' },
			{ id: 'r2', content: 'Updated task' },
			{ id: 'r3', content: 'Added task' },
		]);
	});

	it('reparses cache entries with an old parser version or invalid JSON', async () => {
		const workspace = await createEnv({
			bucketEntries: {
				'files/Reminders/Inbox.md': '# Inbox\n\n- [ ] First task <!-- crate-id:r1 -->\n',
				'files/Reminders/Work.md': '# Work\n\n- [ ] Second task <!-- crate-id:r2 -->\n',
			},
			files: {
				'Reminders/Inbox.md': null,
				'Reminders/Work.md': null,
			},
		});
		const bucketGet = workspace.env.BUCKET.get as ReturnType<typeof vi.fn>;

		await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		workspace.setCachedParserVersion('Reminders', 'Reminders/Inbox.md', 0);
		workspace.corruptCachedReminders('Reminders', 'Reminders/Work.md');
		const response = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);

		expect(response.status).toBe(200);
		expect(bucketGet).toHaveBeenCalledTimes(4);
	});

	it('does not let a stale parser overwrite a newer file cache entry', async () => {
		const originalContent = '# Inbox\n\n- [ ] Original task <!-- crate-id:r1 -->\n';
		const workspace = await createEnv({
			bucketEntries: { 'files/Reminders/Inbox.md': originalContent },
			files: { 'Reminders/Inbox.md': null },
		});
		const bucketGet = workspace.env.BUCKET.get as ReturnType<typeof vi.fn>;

		await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		const oldHash = workspace.getCurrentHash('Reminders/Inbox.md');
		expect(oldHash).toBeTruthy();

		await workspace.replaceCurrentFile(
			'Reminders/Inbox.md',
			'# Inbox\n\n- [ ] Current task <!-- crate-id:r1 -->\n',
		);
		await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		await saveReminderFileCache(
			workspace.env.DB as never,
			'Reminders',
			'Reminders/Inbox.md',
			oldHash ?? '',
			scanReminderMarkdownFile('Reminders/Inbox.md', originalContent, 'Reminders'),
		);

		const response = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			workspace.env as never,
		);
		const result = await response.json() as { reminders: Array<{ content: string }> };
		expect(result.reminders.map((reminder) => reminder.content)).toEqual(['Current task']);
		expect(bucketGet).toHaveBeenCalledTimes(2);
	});
});
