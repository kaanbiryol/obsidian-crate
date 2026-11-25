/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { applySchema } from '../test-support/schema-test-harness';
import { handleListReminders } from './handlers/list';
import { saveReminderFileCache } from './cache/index';
import { scanReminderMarkdownContent } from '@/reminders/core/markdownScan';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from '../sync/markdown-files';
import { reminderRevision } from '@/reminders/core/reminderRevision';
import { DELTA_BASE_HEADER } from '@/protocol/http-headers';

const { DB: db, BUCKET: bucket } = env;
beforeEach(async () => {
	await applySchema(db);
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

async function seed(files: Record<string, string>) {
	for (const [path, content] of Object.entries(files)) await writeCommittedMarkdownFile(bucket, db, path, content, null);
}
async function replace(path: string, content: string) {
	await writeCommittedMarkdownFile(bucket, db, path, content, (await readCommittedMarkdownFileVersion(bucket, db, path))!.hash);
}
function list(etag?: string) {
	return handleListReminders(new Request('https://worker.test/reminders/list?folderPath=Reminders', {
		headers: etag ? { 'If-None-Match': etag } : {},
	}), env);
}
const twoProjects = {
	'Reminders/Inbox.md': '# Inbox\n\n- [ ] First task <!-- crate-id:r1 -->\n',
	'Reminders/Work.md': '# Work\n\n- [ ] Second task <!-- crate-id:r2 -->\n',
};

describe('reminder list cache with D1 and R2', () => {
	it('lists reminders from markdown files in the configured folder', async () => {
		await seed({ 'Reminders/Inbox.md': '# Inbox\n\n- [ ] First task <!-- crate-id:r1 -->\n- [x] Done task <!-- crate-id:r2 -->\n' });

		const response = await list();

		expect(response.status).toBe(200);
		const result = await response.json() as { reminders: Array<{ id: string }>; projects: string[] };
		expect(result.reminders.map(reminder => reminder.id)).toEqual(['r1', 'r2']);
		expect(result.projects).toEqual(['Inbox']);
		expect(result.reminders[0]).not.toHaveProperty('projectColor');
	});

	it('warms a cold reminder index across bounded requests', async () => {
		await seed(Object.fromEntries(Array.from({ length: 25 }, (_, index) => [
			`Reminders/Project-${String(index).padStart(2, '0')}.md`,
			`# Project ${index}\n\n- [ ] Task ${index} <!-- crate-id:r-${index} -->\n`,
		])));
		const bucketGet = vi.spyOn(bucket, 'get');
		const dbBatch = vi.spyOn(db, 'batch');

		const warming = await list();
		expect(warming.status).toBe(202);
		expect(await warming.json()).toEqual({ warming: true, remainingFiles: 5, totalFiles: 25 });
		expect(warming.headers.get('Retry-After')).toBe('1');
		expect(bucketGet).toHaveBeenCalledTimes(20);

		const ready = await list();
		expect(ready.status).toBe(200);
		expect((await ready.json() as { reminders: unknown[] }).reminders).toHaveLength(25);
		expect(bucketGet).toHaveBeenCalledTimes(25);
		expect(Math.max(...dbBatch.mock.calls.map(call => call[0].length))).toBeLessThanOrEqual(20);
	});

	it('keeps healthy files available and reports uncacheable parsed reminder data', async () => {
		const oversizedContent = Array.from({ length: 12_000 }, (_, index) => `- [ ] Task ${index} <!-- crate-id:r-${index} -->`).join('\n');
		expect(new TextEncoder().encode(oversizedContent).byteLength).toBeLessThan(1024 * 1024);
		await seed({
			'Reminders/00-Oversized.md': oversizedContent,
			...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
				`Reminders/Project-${String(index).padStart(2, '0')}.md`, `- [ ] Task ${index} <!-- crate-id:small-${index} -->`,
			])),
		});
		const bucketGet = vi.spyOn(bucket, 'get');

		expect((await list()).status).toBe(202);
		const ready = await list();
		expect(ready.status).toBe(200);
		const data = await ready.json() as { reminders: unknown[]; issues: Array<{ path: string }> };
		expect(data.reminders).toHaveLength(20);
		expect(data.issues).toMatchObject([{ path: 'Reminders/00-Oversized.md' }]);
		const reads = bucketGet.mock.calls.length;
		expect((await list()).status).toBe(200);
		expect(bucketGet).toHaveBeenCalledTimes(reads);
	});

	it('returns 304 from file metadata without reading markdown objects again', async () => {
		await seed(twoProjects);
		const bucketGet = vi.spyOn(bucket, 'get');

		const first = await list();
		const etag = first.headers.get('ETag');
		expect(etag).toMatch(/^"[a-f0-9]{32}\.[a-f0-9]{32}"$/);
		expect(bucketGet).toHaveBeenCalledTimes(2);

		const second = await list(etag ?? '');
		expect(second.status).toBe(304);
		expect(bucketGet).toHaveBeenCalledTimes(2);
	});

	it('reuses cached parses when the client requests a full response again', async () => {
		await seed(twoProjects);
		const bucketGet = vi.spyOn(bucket, 'get');

		await list();
		const response = await list();

		expect(response.status).toBe(200);
		expect(bucketGet).toHaveBeenCalledTimes(2);
		expect((await response.json() as { reminders: Array<{ id: string }> }).reminders.map(reminder => reminder.id)).toEqual(['r1', 'r2']);
	});

	it('reads and reparses only the file whose hash changed', async () => {
		await seed(twoProjects);
		await list();
		await replace('Reminders/Work.md', '# Work\n\n- [ ] Updated task <!-- crate-id:r2 -->\n- [ ] Added task <!-- crate-id:r3 -->\n');
		const bucketGet = vi.spyOn(bucket, 'get');

		const response = await list();

		expect(bucketGet).toHaveBeenCalledTimes(1);
		expect((await response.json() as { reminders: unknown[] }).reminders).toMatchObject([
			{ id: 'r1', content: 'First task' },
			{ id: 'r2', content: 'Updated task' },
			{ id: 'r3', content: 'Added task' },
		]);
	});

	it('reparses cache entries with an old parser version or invalid JSON', async () => {
		await seed(twoProjects);
		await list();
		await db.prepare("UPDATE reminder_file_cache SET parser_version = 0 WHERE folder_path = 'Reminders' AND file_path = 'Reminders/Inbox.md'").run();
		await db.prepare("UPDATE reminder_file_cache SET reminders_json = '{not json' WHERE folder_path = 'Reminders' AND file_path = 'Reminders/Work.md'").run();
		const bucketGet = vi.spyOn(bucket, 'get');

		const response = await list();

		expect(response.status).toBe(200);
		expect(bucketGet).toHaveBeenCalledTimes(2);
	});

	it('does not let a stale parser overwrite a newer file cache entry', async () => {
		const path = 'Reminders/Inbox.md', originalContent = '# Inbox\n\n- [ ] Original task <!-- crate-id:r1 -->\n';
		await seed({ [path]: originalContent });
		await list();
		const oldHash = (await readCommittedMarkdownFileVersion(bucket, db, path))!.hash;
		await replace(path, '# Inbox\n\n- [ ] Current task <!-- crate-id:r1 -->\n');
		await list();
		await saveReminderFileCache(db, 'Reminders', path, oldHash, scanReminderMarkdownContent(path, originalContent, 'Reminders').reminders);
		const bucketGet = vi.spyOn(bucket, 'get');

		const response = await list();

		expect((await response.json() as { reminders: Array<{ content: string }> }).reminders.map(reminder => reminder.content)).toEqual(['Current task']);
		expect(bucketGet).not.toHaveBeenCalled();
	});
	it('stores each revision with its cache row and backfills rows cached without one', async () => {
		await seed(twoProjects);
		type Listed = { reminders: Array<{ id: string; revision: string }> };
		const first = await (await list()).json() as Listed;
		const scanned = scanReminderMarkdownContent('Reminders/Inbox.md', twoProjects['Reminders/Inbox.md'], 'Reminders').reminders[0]!;
		expect(first.reminders[0]!.revision).toBe(await reminderRevision(scanned));
		const stored = async () => (await db.prepare("SELECT reminders_json FROM reminder_file_cache WHERE file_path = 'Reminders/Inbox.md'").first<{ reminders_json: string }>())!.reminders_json;
		expect(JSON.parse(await stored())).toMatchObject([{ id: 'r1', revision: first.reminders[0]!.revision }]);

		// A row cached before revisions were stored is listed the same and gains its revision.
		const legacy = JSON.parse(await stored()) as Array<Record<string, unknown>>;
		await db.prepare("UPDATE reminder_file_cache SET reminders_json = ? WHERE file_path = 'Reminders/Inbox.md'")
			.bind(JSON.stringify(legacy.map(({ revision: _revision, ...reminder }) => reminder))).run();
		const bucketGet = vi.spyOn(bucket, 'get');
		expect(await (await list()).json()).toEqual(first);
		expect(JSON.parse(await stored())).toMatchObject([{ revision: first.reminders[0]!.revision }]);
		expect(bucketGet).not.toHaveBeenCalled();

		// The listed revision is the stored one rather than a new hash.
		const marked = 'f'.repeat(64);
		await db.prepare("UPDATE reminder_file_cache SET reminders_json = ? WHERE file_path = 'Reminders/Inbox.md'")
			.bind(JSON.stringify(legacy.map(reminder => ({ ...reminder, revision: marked })))).run();
		expect(((await (await list()).json()) as Listed).reminders[0]!.revision).toBe(marked);
	});

	it('answers 304 for an unchanged list with issues, without a delta base', async () => {
		await seed({
			'Reminders/Inbox.md': '# Inbox\n\n- [ ] First task <!-- crate-id:r1 -->\n',
			'Reminders/Work.md': '# Work\n\n- [ ] Copied task <!-- crate-id:r1 -->\n',
		});
		const bucketGet = vi.spyOn(bucket, 'get');
		const first = await list();
		expect((await first.json() as { issues: unknown[] }).issues).toHaveLength(2);
		const etag = first.headers.get('ETag')!;
		expect(etag).toMatch(/^"[a-f0-9]{32}\.[a-f0-9]{32}\.i"$/);
		expect(first.headers.get(DELTA_BASE_HEADER)).toBeNull();

		const unchanged = await list(etag);
		expect(unchanged.status).toBe(304);
		expect(unchanged.headers.get(DELTA_BASE_HEADER)).toBeNull();
		// A write elsewhere changes the vault token, and the equal revision still answers 304.
		await writeCommittedMarkdownFile(bucket, db, 'Elsewhere.md', 'Unrelated\n', null);
		const elsewhere = await list(etag);
		expect(elsewhere.status).toBe(304);
		expect(elsewhere.headers.get('ETag')).toMatch(/\.i"$/);
		expect(elsewhere.headers.get(DELTA_BASE_HEADER)).toBeNull();
		expect(bucketGet).toHaveBeenCalledTimes(2);

		await replace('Reminders/Work.md', '# Work\n\n- [ ] Copied task <!-- crate-id:r2 -->\n');
		const fixed = await list(etag);
		expect(fixed.status).toBe(200);
		expect((await fixed.json() as { issues: unknown[] }).issues).toEqual([]);
		expect(fixed.headers.get('ETag')).toMatch(/^"[a-f0-9]{32}\.[a-f0-9]{32}"$/);
		expect(fixed.headers.get(DELTA_BASE_HEADER)).not.toBeNull();
	});
});
