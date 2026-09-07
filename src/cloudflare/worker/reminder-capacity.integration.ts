/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { sha256Hex } from './auth';
import { handleListReminders } from './reminders-web/routes/list';
import { scanReminderMarkdownFile } from './reminders-web/scan';
import { REMINDER_CACHE_PARSER_VERSION } from './reminders-web/reminder-cache';

// A repeatable local workerd/D1/R2 measurement, not a hosted CPU or mobile claim.
beforeEach(async () => {
	for (const sql of schema.split(';').map(sql => sql.trim()).filter(Boolean)) {
		await env.DB.prepare(sql).run();
	}
});
afterEach(async () => { vi.restoreAllMocks(); await reset(); });

async function seedFiles(fileCount: number, remindersPerFile: number, warm: boolean) {
	for (let offset = 0; offset < fileCount; offset += 100) {
		const rows = await Promise.all(Array.from({ length: Math.min(100, fileCount - offset) }, async (_, index) => {
			const file = offset + index;
			const path = `Reminders/Note-${String(file).padStart(5, '0')}.md`;
			const content = Array.from({ length: remindersPerFile }, (_, line) =>
				`- [ ] Task ${file}-${line} @2099-01-02 <!-- crate-id:${crypto.randomUUID()} -->`,
			).join('\n');
			if (!warm) await env.BUCKET.put(path, content);
			return {
				path,
				hash: await sha256Hex(content),
				size: new TextEncoder().encode(content).byteLength,
				reminders: warm ? scanReminderMarkdownFile(path, content, 'Reminders') : [],
			};
		}));
		const json = JSON.stringify(rows);
		await env.DB.prepare(`INSERT INTO files (path, portable_path, hash, size, storage_key)
			SELECT json_extract(value, '$.path'), lower(json_extract(value, '$.path')),
			json_extract(value, '$.hash'), json_extract(value, '$.size'), json_extract(value, '$.path')
			FROM json_each(?)`).bind(json).run();
		if (warm) {
			await env.DB.prepare(`INSERT INTO reminder_file_cache
				(folder_path, file_path, file_hash, parser_version, reminders_json)
				SELECT 'Reminders', json_extract(value, '$.path'), json_extract(value, '$.hash'),
				?, json_extract(value, '$.reminders') FROM json_each(?)`)
				.bind(REMINDER_CACHE_PARSER_VERSION, json).run();
		}
	}
}

function listRequest(etag?: string) {
	return new Request('https://capacity.test/notifications/reminders?folderPath=Reminders', {
		headers: etag ? { 'If-None-Match': etag } : {},
	});
}

async function measureWarmLists(expectedCount: number) {
	const query = vi.spyOn(env.DB, 'prepare');
	const samples = [];
	for (let sample = 0; sample < 3; sample++) {
		query.mockClear();
		const start = performance.now();
		const response = await handleListReminders(listRequest(), env);
		const body = await response.text();
		const elapsedMs = performance.now() - start;
		const queries = query.mock.calls.length;
		const parsed = JSON.parse(body) as { reminders: Array<{ id: string }>; issues: unknown[] };
		expect(response.status).toBe(200);
		expect(parsed.reminders).toHaveLength(expectedCount);
		expect(new Set(parsed.reminders.map(reminder => reminder.id)).size).toBe(expectedCount);
		expect(parsed.issues).toEqual([]);
		query.mockClear();
		const unchangedStart = performance.now();
		const etag = response.headers.get('ETag');
		expect(etag).toBeTruthy();
		const unchanged = await handleListReminders(listRequest(etag!), env);
		expect(unchanged.status).toBe(304);
		samples.push({
			wallMs: Math.round(elapsedMs), bytes: new TextEncoder().encode(body).byteLength, queries,
			unchangedWallMs: Math.round(performance.now() - unchangedStart),
			unchangedQueries: query.mock.calls.length,
		});
	}
	query.mockRestore();
	return samples;
}

it.for([1000, 10000])('returns all %i reminders from a warm one-reminder-per-file folder', { timeout: 120_000 }, async (count, context) => {
	await seedFiles(count, 1, true);
	await context.annotate(JSON.stringify({
		scenario: 'warm-one-reminder-per-file', localOnly: true, reminders: count, files: count,
		samples: await measureWarmLists(count),
	}), 'capacity');
});

it.for([1000, 10000])('warms a cold %i-reminder folder through bounded requests', { timeout: 120_000 }, async (count, context) => {
	const files = count / 10;
	await seedFiles(files, 10, false);
	const start = performance.now();
	let requests = 0;
	let previousRemaining = files;
	let longestRequestMs = 0;
	while (requests <= files) {
		const requestStart = performance.now();
		const response = await handleListReminders(listRequest(), env);
		const body = await response.json() as { remainingFiles?: number; reminders?: unknown[] };
		longestRequestMs = Math.max(longestRequestMs, performance.now() - requestStart);
		requests++;
		if (response.status === 200) {
			expect(body.reminders).toHaveLength(count);
			break;
		}
		expect(response.status).toBe(202);
		expect(body.remainingFiles).toBeLessThan(previousRemaining);
		expect(body.remainingFiles).toBeGreaterThan(0);
		previousRemaining = body.remainingFiles!;
	}
	expect(requests).toBeLessThanOrEqual(files);
	await context.annotate(JSON.stringify({
		scenario: 'cold-ten-reminders-per-file', localOnly: true, reminders: count, files, requests,
		wallMs: Math.round(performance.now() - start), longestRequestMs: Math.round(longestRequestMs),
		samples: await measureWarmLists(count),
	}), 'capacity');
});
