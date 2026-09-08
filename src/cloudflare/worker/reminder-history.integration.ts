/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { pruneReminderOccurrences } from './maintenance/reminder-history';
import { writeCommittedMarkdownFile } from './storage';
import { handleNotificationPolicy } from './notification-policy';
import { drainNotificationProjections } from './notification-projection';

beforeEach(async () => {
	for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
});
afterEach(async () => { await reset(); });
const old = Date.parse('2000-01-01T00:00:00Z');
const due = '2000-01-02T09:00:00.000Z';
async function occurrence(id: string, key = due, seen = old) {
	await env.DB.prepare('INSERT INTO reminder_occurrences VALUES (?, ?, ?)').bind(id, key, seen).run();
}

it('preserves active, quarantined, recent and future occurrences while pruning obsolete history', async () => {
	for (const id of ['obsolete', 'active', 'quarantined']) await occurrence(id);
	await occurrence('recently-seen', due, Date.now());
	await occurrence('recently-due', new Date(Date.now() - 60_000).toISOString());
	await occurrence('future', '2099-01-01T09:00:00.000Z');
	await occurrence('all-day', '2000-01-02');
	await occurrence('unknown-format', 'not-a-date');
	for (const id of ['active', 'quarantined']) {
		await env.DB.prepare('INSERT INTO reminder_sources VALUES (?, ?, ?, 1)').bind(`Reminders/${id}.md`, id, due).run();
	}
	await env.DB.prepare('INSERT INTO reminder_source_state (file_path, file_revision, parser_version, verified) VALUES (?, ?, 0, 0)')
		.bind('Reminders/quarantined.md', 'unverified-revision').run();
	await pruneReminderOccurrences(env.DB);
	expect((await env.DB.prepare('SELECT reminder_id FROM reminder_occurrences ORDER BY reminder_id').all()).results)
		.toEqual(['active', 'future', 'quarantined', 'recently-due', 'recently-seen', 'unknown-format'].map(reminder_id => ({ reminder_id })));
});

it('bounds deletion to 500 rows and resumes idempotently without pruning mutation receipts or identities', async () => {
	await env.DB.prepare(`INSERT INTO reminder_occurrences SELECT value, ?, ? FROM json_each(?)`)
		.bind(due, old, JSON.stringify(Array.from({ length: 501 }, (_, index) => `history-${index}`))).run();
	await env.DB.prepare("INSERT INTO reminder_operations VALUES ('old-operation', 'hash', '{}', '2000-01-01 00:00:00')").run();
	await env.DB.prepare("INSERT INTO reminder_identities VALUES ('old-identity', 'old-operation')").run();
	await pruneReminderOccurrences(env.DB);
	expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM reminder_occurrences').first()).toEqual({ count: 1 });
	await pruneReminderOccurrences(env.DB);
	await pruneReminderOccurrences(env.DB);
	expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM reminder_occurrences').first()).toEqual({ count: 0 });
	expect(await env.DB.prepare('SELECT operation_id FROM reminder_operations').first()).toEqual({ operation_id: 'old-operation' });
	expect(await env.DB.prepare('SELECT reminder_id FROM reminder_identities').first()).toEqual({ reminder_id: 'old-identity' });
});

it('does not rearm a forgotten occurrence when old Markdown is restored after cleanup', async () => {
	const id = '11111111-1111-4111-8111-111111111111';
	await occurrence(id);
	await pruneReminderOccurrences(env.DB);
	await handleNotificationPolicy(new Request('https://test/policy', { method: 'POST',
		body: JSON.stringify({ folderPath: 'Reminders', timezone: 'UTC', allDayTime: '09:00' }) }), env.DB);
	await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Restored.md', `- [ ] Old task @${due} <!-- crate-id:${id} -->`, null);
	await drainNotificationProjections(env);
	expect(await env.DB.prepare('SELECT operation FROM notification_jobs WHERE reminder_id = ?').bind(id).first()).toEqual({ operation: 'cancel' });
	const observed = await env.DB.prepare('SELECT first_seen_at FROM reminder_occurrences WHERE reminder_id = ?').bind(id).first<{ first_seen_at: number }>();
	expect(observed!.first_seen_at).toBeGreaterThan(Date.parse(due));
});
