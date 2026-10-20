/// <reference types="@cloudflare/vitest-plugin/types" />

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset, runDurableObjectAlarm } from 'cloudflare:test';
import { applySchema } from './test-support/schema-test-harness';
import { writeCommittedMarkdownFilePair } from './sync/atomic-markdown-write';
import { MAINTENANCE_DELETE_LIMIT, pruneChangelog } from './db';
import { drainNotificationJobs } from './notifications/outbox';
import type { Env } from './types';
import { handleListReminders } from './reminders/routes/list';
import {
	FileVersionConflictError,
	readCommittedMarkdownFileVersion,
	writeCommittedMarkdownFile,
} from './storage';

const runtimeEnv: Env = env;

beforeEach(async () => {
	await applySchema(runtimeEnv.DB);
});

afterEach(async () => {
	await reset();
});

describe('Cloudflare runtime integration', () => {
	it('applies the initial schema to a real D1 database', async () => {
		const result = await runtimeEnv.DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
		).all<{ name: string }>();
		const tables = result.results.map(row => row.name);

		expect(tables).toEqual(expect.arrayContaining([
			'auth_tokens',
			'changelog',
			'files',
			'object_cleanup_queue',
			'reminder_file_cache',
			'scheduled_reminders',
		]));
	});

	it('commits a two-file reminder move atomically and rejects stale CAS input', async () => {
		const sourcePath = 'Reminders/Inbox.md';
		const destinationPath = 'Reminders/Work.md';
		const originalSource = await writeCommittedMarkdownFile(
			runtimeEnv.BUCKET,
			runtimeEnv.DB,
			sourcePath,
			'# Inbox\n\n- [ ] Move me <!-- crate-id:r1 -->\n',
			null,
		);

		const move = await writeCommittedMarkdownFilePair(runtimeEnv.BUCKET, runtimeEnv.DB, {
			source: {
				path: sourcePath,
				content: '# Inbox\n',
				expectedHash: originalSource.hash,
			},
			destination: {
				path: destinationPath,
				content: '# Work\n\n- [ ] Move me <!-- crate-id:r1 -->\n',
				expectedHash: null,
			},
		});

		await expect(readCommittedMarkdownFileVersion(
			runtimeEnv.BUCKET,
			runtimeEnv.DB,
			sourcePath,
		)).resolves.toMatchObject({ content: '# Inbox\n', hash: move.source.hash });
		await expect(readCommittedMarkdownFileVersion(
			runtimeEnv.BUCKET,
			runtimeEnv.DB,
			destinationPath,
		)).resolves.toMatchObject({ hash: move.destination.hash });

		const concurrentSource = await writeCommittedMarkdownFile(
			runtimeEnv.BUCKET,
			runtimeEnv.DB,
			sourcePath,
			'# Inbox\n\n- [ ] Concurrent edit <!-- crate-id:r2 -->\n',
			move.source.hash,
		);
		const staleDestinationPath = 'Reminders/Personal.md';
		await expect(writeCommittedMarkdownFilePair(runtimeEnv.BUCKET, runtimeEnv.DB, {
			source: {
				path: sourcePath,
				content: '# Inbox\n',
				expectedHash: move.source.hash,
			},
			destination: {
				path: staleDestinationPath,
				content: '# Personal\n\n- [ ] Stale move <!-- crate-id:r2 -->\n',
				expectedHash: null,
			},
		})).rejects.toBeInstanceOf(FileVersionConflictError);

		expect(await readCommittedMarkdownFileVersion(
			runtimeEnv.BUCKET,
			runtimeEnv.DB,
			staleDestinationPath,
		)).toBeNull();
		await expect(readCommittedMarkdownFileVersion(
			runtimeEnv.BUCKET,
			runtimeEnv.DB,
			sourcePath,
		)).resolves.toMatchObject({ hash: concurrentSource.hash });
	});

	it('warms reminder cache entries across bounded Worker requests', async () => {
		for (let index = 0; index < 25; index += 1) {
			const path = `Reminders/Project-${String(index).padStart(2, '0')}.md`;
			await writeCommittedMarkdownFile(
				runtimeEnv.BUCKET,
				runtimeEnv.DB,
				path,
				`# Project ${index}\n\n- [ ] Task ${index} <!-- crate-id:r-${index} -->\n`,
				null,
			);
		}

		const firstResponse = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			runtimeEnv,
		);
		expect(firstResponse.status).toBe(202);
		expect(await firstResponse.json()).toEqual({ warming: true, remainingFiles: 5, totalFiles: 25 });
		const firstCacheCount = await runtimeEnv.DB.prepare(
			'SELECT COUNT(*) AS count FROM reminder_file_cache',
		).first<{ count: number }>();
		expect(firstCacheCount?.count).toBe(20);

		const secondResponse = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			runtimeEnv,
		);
		expect(secondResponse.status).toBe(200);
		const result = await secondResponse.json() as { reminders: Array<{ id: string }> };
		expect(result.reminders).toHaveLength(25);
	});

	it('answers idle reminder polls from the vault change token and unrelated edits from the folder revision', async () => {
		await writeCommittedMarkdownFile(runtimeEnv.BUCKET, runtimeEnv.DB, 'Reminders/Inbox.md', '- [ ] Task <!-- crate-id:task -->', null);
		const list = (etag?: string) => handleListReminders(new Request('https://worker.test/reminders/list?folderPath=Reminders',
			{ headers: etag ? { 'If-None-Match': etag } : {} }), runtimeEnv);
		const first = await list();
		const etag = first.headers.get('ETag')!;
		const idle = await list(etag);
		expect(idle.status).toBe(304);
		expect(idle.headers.get('ETag')).toBe(etag);
		await writeCommittedMarkdownFile(runtimeEnv.BUCKET, runtimeEnv.DB, 'Notes/Other.md', 'Unrelated', null);
		const unrelated = await list(etag);
		expect(unrelated.status).toBe(304);
		const refreshed = unrelated.headers.get('ETag')!;
		expect(refreshed).not.toBe(etag);
		expect(refreshed.split('.')[1]).toBe(etag.split('.')[1]);
		await writeCommittedMarkdownFile(runtimeEnv.BUCKET, runtimeEnv.DB, 'Reminders/Next.md', '- [ ] Next <!-- crate-id:next -->', null);
		expect((await list(refreshed)).status).toBe(200);
		const otherFolder = await handleListReminders(new Request('https://worker.test/reminders/list?folderPath=Notes',
			{ headers: { 'If-None-Match': refreshed } }), runtimeEnv);
		expect(otherFolder.status).toBe(200);
	});

	it('returns only notes changed since a delta base, including deletions', async () => {
		await writeCommittedMarkdownFile(runtimeEnv.BUCKET, runtimeEnv.DB, 'Reminders/A.md', '- [ ] Alpha <!-- crate-id:alpha -->', null);
		await writeCommittedMarkdownFile(runtimeEnv.BUCKET, runtimeEnv.DB, 'Reminders/B.md', '- [ ] Beta <!-- crate-id:beta -->', null);
		const list = (since?: string) => handleListReminders(new Request(`https://worker.test/reminders/list?folderPath=Reminders${since ? `&since=${encodeURIComponent(since)}` : ''}`), runtimeEnv);
		const first = await list();
		const base = first.headers.get('X-Crate-Delta-Base')!;
		expect(base).toMatch(/^\d+\.[a-f0-9]{32}$/);
		const b = (await readCommittedMarkdownFileVersion(runtimeEnv.BUCKET, runtimeEnv.DB, 'Reminders/B.md'))!;
		await writeCommittedMarkdownFile(runtimeEnv.BUCKET, runtimeEnv.DB, 'Reminders/B.md', '- [x] Beta <!-- crate-id:beta -->', b.hash);
		await writeCommittedMarkdownFile(runtimeEnv.BUCKET, runtimeEnv.DB, 'Notes/Elsewhere.md', 'Unrelated', null);
		const delta = await list(base);
		expect(await delta.json()).toMatchObject({ delta: true, changedPaths: ['Reminders/B.md'], reminders: [{ id: 'beta', completed: true }], issues: [] });
		// A base from another view or a cursor the changelog cannot prove gets a full list.
		const full = await (await list(`${base.split('.')[0]}.${'0'.repeat(32)}`)).json() as { delta?: boolean; reminders: unknown[] };
		expect(full.delta).toBeUndefined();
		expect(full.reminders).toHaveLength(2);
		expect((await (await list(`999999.${base.split('.')[1]}`)).json() as { delta?: boolean }).delta).toBeUndefined();
	});

	it('answers 304 without listing the folder after writes elsewhere in the vault', async () => {
		await writeCommittedMarkdownFile(runtimeEnv.BUCKET, runtimeEnv.DB, 'Reminders/A.md', '- [ ] Alpha <!-- crate-id:alpha -->', null);
		const first = await handleListReminders(new Request('https://worker.test/reminders/list?folderPath=Reminders'), runtimeEnv);
		const etag = first.headers.get('ETag')!, base = first.headers.get('X-Crate-Delta-Base')!;
		const list = async (since: string) => {
			const prepare = runtimeEnv.DB.prepare.bind(runtimeEnv.DB);
			const statements: string[] = [];
			runtimeEnv.DB.prepare = (sql: string) => { statements.push(sql); return prepare(sql); };
			try {
				const response = await handleListReminders(new Request(`https://worker.test/reminders/list?folderPath=Reminders&since=${encodeURIComponent(since)}`,
					{ headers: { 'If-None-Match': etag } }), runtimeEnv);
				return { response, listed: statements.some(sql => sql.includes('FROM files')), offset: statements.some(sql => sql.includes('OFFSET')) };
			} finally { runtimeEnv.DB.prepare = prepare; }
		};
		await writeCommittedMarkdownFile(runtimeEnv.BUCKET, runtimeEnv.DB, 'Notes/Elsewhere.md', 'Unrelated', null);
		const elsewhere = await list(base);
		expect(elsewhere).toMatchObject({ listed: false, offset: false });
		expect(elsewhere.response.status).toBe(304);
		expect(elsewhere.response.headers.get('ETag')!.split('.')[1]).toBe(etag.split('.')[1]);
		// A base the ETag was not issued at falls back to listing the folder.
		const mismatched = await list(`${Number(base.split('.')[0]) + 1}.${base.split('.')[1]}`);
		expect(mismatched).toMatchObject({ listed: true });
		expect(mismatched.response.status).toBe(304);
		await writeCommittedMarkdownFile(runtimeEnv.BUCKET, runtimeEnv.DB, 'Reminders/B.md', '- [ ] Beta <!-- crate-id:beta -->', null);
		const changed = await list(base);
		expect(changed.response.status).toBe(200);
		expect(await changed.response.json()).toMatchObject({ delta: true, changedPaths: ['Reminders/B.md'] });
	});

	it('keeps reminder folder matching case-sensitive', async () => {
		await Promise.all([
			writeCommittedMarkdownFile(
				runtimeEnv.BUCKET,
				runtimeEnv.DB,
				'Reminders/Included.md',
				'- [ ] Included <!-- crate-id:included -->',
				null,
			),
			writeCommittedMarkdownFile(
				runtimeEnv.BUCKET,
				runtimeEnv.DB,
				'reminders/Excluded.md',
				'- [ ] Excluded <!-- crate-id:excluded -->',
				null,
			),
		]);

		const response = await handleListReminders(
			new Request('https://worker.test/reminders/list?folderPath=Reminders'),
			runtimeEnv,
		);
		const result = await response.json() as { reminders: Array<{ id: string }> };

		expect(response.status).toBe(200);
		expect(result.reminders.map(reminder => reminder.id)).toEqual(['included']);
	});

	it('retains the latest sync cursor after pruning a quiet changelog', async () => {
		await runtimeEnv.DB.batch([
			runtimeEnv.DB.prepare(
				"INSERT INTO changelog (path, action, created_at) VALUES ('old.md', 'put', datetime('now', '-60 days'))",
			),
			runtimeEnv.DB.prepare(
				"INSERT INTO changelog (path, action, created_at) VALUES ('latest.md', 'put', datetime('now', '-45 days'))",
			),
		]);
		const latestBeforePrune = await runtimeEnv.DB.prepare(
			'SELECT MAX(seq) AS seq FROM changelog',
		).first<{ seq: number }>();

		await pruneChangelog(runtimeEnv.DB);

		const retained = await runtimeEnv.DB.prepare(
			'SELECT seq, path FROM changelog ORDER BY seq',
		).all<{ seq: number; path: string }>();
		expect(retained.results).toEqual([{ seq: latestBeforePrune?.seq, path: 'latest.md' }]);
	});

	it('prunes a large expired changelog in bounded oldest-first batches', async () => {
		const count = MAINTENANCE_DELETE_LIMIT + 250;
		await runtimeEnv.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < ?)
			INSERT INTO changelog (path, action, created_at) SELECT 'n'||x, 'put', datetime('now', '-60 days', '+'||x||' seconds') FROM n`).bind(count).run();
		expect(await pruneChangelog(runtimeEnv.DB)).toBe(true);
		const bounds = await runtimeEnv.DB.prepare('SELECT MIN(seq) AS min, MAX(seq) AS max, COUNT(*) AS rows FROM changelog').first<{ min: number; max: number; rows: number }>();
		// The retained range stays contiguous, so cursor expiry remains exact.
		expect(bounds).toEqual({ min: MAINTENANCE_DELETE_LIMIT + 1, max: count, rows: 250 });
		expect(await pruneChangelog(runtimeEnv.DB)).toBe(false);
		expect((await runtimeEnv.DB.prepare('SELECT COUNT(*) AS rows FROM changelog').first<{ rows: number }>())?.rows).toBe(1);
	});

	it('fences an unprojected alarm in real Durable Object storage', async () => {
		const reminderId = 'runtime-reminder';
		await runtimeEnv.DB.prepare("INSERT INTO notification_jobs (reminder_id, job_token, operation, payload_json, available_at) VALUES (?, ?, 'schedule', ?, 0)")
			.bind(reminderId, 'runtime-job', JSON.stringify({ reminderId, content: 'Runtime alarm', project: 'Work', dueDatetime: '2099-01-01T00:00:00.000Z' })).run();
		await drainNotificationJobs(runtimeEnv);
		const stub = runtimeEnv.REMINDER_ALARMS.get(runtimeEnv.REMINDER_ALARMS.idFromName(reminderId));

		expect(await runDurableObjectAlarm(stub as never)).toBe(false);
		const scheduled = await runtimeEnv.DB.prepare(
			'SELECT reminder_id FROM scheduled_reminders WHERE reminder_id = ?',
		).bind(reminderId).first();
		expect(scheduled).toBeNull();
		const pending = await runtimeEnv.DB.prepare(
			'SELECT job_token, operation, attempts, available_at FROM notification_jobs WHERE reminder_id = ?',
		).bind(reminderId).first<{ job_token: string; operation: string; attempts: number; available_at: number }>();
		expect(pending).toMatchObject({ job_token: 'runtime-job', operation: 'schedule', attempts: 1 });
		expect(pending!.available_at).toBeGreaterThan(Date.now());
	});
});
