/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterAll, beforeAll, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applySchema } from '../test-support/schema-test-harness';
import { installStorageCostMeter, type StorageCostMeter } from '../test-support/storage-cost-test-harness';
import worker from '../index';
import { readCommittedMarkdownFileVersion, writeCommittedMarkdownFile } from '../storage';
import { scanReminderMarkdownContent } from '@/reminders/core/markdownScan';
import { createReminderOperationId } from '@/protocol/reminder-operation';
import { reminderRevision } from '@/reminders/core/reminderRevision';
import { sha256Hex } from '@/platform/sha256';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol/server-info';

// Costs include the notification pass each request arms, which the usage header omits.
let meter: StorageCostMeter;
const SMALL = 'Reminders/Small.md', LARGE = 'Reminders/Large.md';
const note = (count: number) => `# Tasks\n\n${Array.from({ length: count }, (_, index) =>
	`- [ ] Task ${index}${index < 10 ? ` 2099-01-0${1 + (index % 9)}T09:00:00.000Z` : ''} <!-- crate-id:${crypto.randomUUID()} -->`).join('\n')}\n`;

function send(path: string, body?: string) {
	return worker.fetch(new Request(`https://crate.test${path}`, { method: body ? 'POST' : 'GET', body,
		headers: { Authorization: 'Bearer web-session', [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current), 'Content-Type': 'application/json' } }), env);
}
// Plain words: random text can read as reminder metadata such as a date.
const titles = ['Edited alpha', 'Edited bravo', 'Edited charlie', 'Edited delta', 'Edited echo', 'Edited foxtrot'];
let edits = 0;
async function editBody(path: string, index: number) {
	const reminder = scanReminderMarkdownContent(path, (await readCommittedMarkdownFileVersion(env.BUCKET, env.DB, path))!.content, 'Reminders').reminders[index]!;
	return JSON.stringify({ operationId: createReminderOperationId(Math.floor(Date.now() / 86_400_000)), id: reminder.id, folderPath: 'Reminders',
		filePath: path, expectedRevision: await reminderRevision(reminder), content: titles[edits++ % titles.length] });
}
async function edit(path: string, index: number, alarms = true) {
	const body = await editBody(path, index);
	const { result, cost } = await meter.measure(() => send('/reminders/update', body), { alarms });
	expect(result.status, await result.clone().text()).toBe(200);
	return { cost, body };
}

beforeAll(async () => {
	await applySchema(env.DB);
	await env.DB.prepare("INSERT INTO auth_tokens(id, token_hash, scope, folder_path, last_seen_at) VALUES ('web', ?, 'reminders', 'Reminders', datetime('now'))")
		.bind(await sha256Hex('web-session')).run();
	await env.DB.prepare("INSERT INTO notification_policy(id, folder_path, timezone, revision) VALUES (1, 'Reminders', 'UTC', 'policy')").run();
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, SMALL, note(20), null);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, LARGE, note(400), null);
	meter = await installStorageCostMeter();
	// Index the folder and project both notes before measuring.
	for (let attempt = 0; attempt < 20 && (await send('/reminders/list?folderPath=Reminders')).status === 202; attempt++);
	await meter.settle();
}, 120_000);
afterAll(async () => { await meter?.restore(); });

it('writes about the same rows for one reminder edit in a 20- and a 400-reminder note', async () => {
	const small = await edit(SMALL, 12);
	const large = await edit(LARGE, 12);
	console.info('reminder edit cost', { small: small.cost, large: large.cost });
	// Was 123 and 2,023 rows.
	expect(small.cost.rowsWritten).toBeLessThan(30);
	expect(large.cost.rowsWritten).toBeLessThan(30);
	expect(Math.abs(large.cost.rowsWritten - small.cost.rowsWritten)).toBeLessThan(5);
}, 60_000);

it('keeps the request to a few D1 round trips and its replay to a cheap pass', async () => {
	const { cost: request, body } = await edit(SMALL, 13, false);
	await meter.settle();
	const { cost: replay } = await meter.measure(() => send('/reminders/update', body));
	console.info('reminder request and replay cost', { request, replay });
	// Was 11: authentication, the receipt and retry window, one read of the commit context,
	// identity checks and note row, the staged lease, the commit and the parsed cache.
	expect(request.queries).toBeLessThanOrEqual(6);
	expect(replay.rowsWritten).toBe(0);
	expect(replay.rowsRead).toBeLessThan(50);
}, 60_000);

it('does not read every reminder note on a pass with nothing to project', async () => {
	await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 2000)
    INSERT INTO reminder_source_state(file_path, file_revision, parser_version, verified) SELECT 'Reminders/Other ' || x || '.md', 'revision', 2, 1 FROM n`).run();
	const { body } = await edit(SMALL, 14);
	const { cost } = await meter.measure(() => send('/reminders/update', body));
	console.info('no-op pass cost with 2,002 reminder notes', cost);
	expect(cost.alarms).toBe(1);
	expect(cost.rowsRead).toBeLessThan(100);
}, 60_000);
