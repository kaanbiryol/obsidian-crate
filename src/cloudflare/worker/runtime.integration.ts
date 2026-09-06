/// <reference types="@cloudflare/vitest-plugin/types" />

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset, runDurableObjectAlarm } from 'cloudflare:test';
import schemaSql from '../schema.sql?raw';
import { writeCommittedMarkdownFilePair } from './atomic-markdown-write';
import { pruneChangelog } from './db';
import { drainNotificationJobs } from './notification-outbox';
import type { Env } from './types';
import { handleListReminders } from './reminders-web/routes/list';
import {
	FileVersionConflictError,
	readCommittedMarkdownFileVersion,
	writeCommittedMarkdownFile,
} from './storage';

const runtimeEnv: Env = env;

beforeEach(async () => {
	for (const statement of schemaSql.split(';').map(value => value.trim()).filter(Boolean)) {
		await runtimeEnv.DB.prepare(statement).run();
	}
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

	it('fences an unprojected alarm in real Durable Object storage', async () => {
		const reminderId = 'runtime-reminder';
		await runtimeEnv.DB.prepare("INSERT INTO notification_jobs (reminder_id, job_token, operation, payload_json, available_at) VALUES (?, ?, 'schedule', ?, 0)")
			.bind(reminderId, 'runtime-job', JSON.stringify({ reminderId, content: 'Runtime alarm', project: 'Work', dueDatetime: '2099-01-01T00:00:00.000Z' })).run();
		await drainNotificationJobs(runtimeEnv);
		const stub = runtimeEnv.REMINDER_ALARMS.get(runtimeEnv.REMINDER_ALARMS.idFromName(reminderId));

		expect(await runDurableObjectAlarm(stub as never)).toBe(true);
		const scheduled = await runtimeEnv.DB.prepare(
			'SELECT reminder_id FROM scheduled_reminders WHERE reminder_id = ?',
		).bind(reminderId).first();
		expect(scheduled).toEqual({ reminder_id: reminderId });

	});
});
