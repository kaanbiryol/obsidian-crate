import { corsResponse } from './cors';
import { initDb, queryRows } from './db';
import type { Env } from './types';

interface ScheduleBody {
	reminderId: string;
	content: string;
	project?: string;
	dueDatetime: string;
	priority?: number;
}

export async function handleScheduleReminder(request: Request, env: Env): Promise<Response> {
	const body = await request.json() as ScheduleBody;

	if (!body.reminderId || !body.content || !body.dueDatetime) {
		return corsResponse({ error: 'reminderId, content, and dueDatetime required' }, 400);
	}

	const db = env.DB;
	if (!db) return corsResponse({ error: 'Database not available' }, 404);

	await initDb(db);

	// Create/update Durable Object alarm
	const id = env.REMINDER_ALARMS.idFromName(body.reminderId);
	const stub = env.REMINDER_ALARMS.get(id);
	const doResp = await stub.fetch('https://do/schedule', {
		method: 'PUT',
		body: JSON.stringify(body),
	});

	if (!doResp.ok) {
		return corsResponse({ error: 'Failed to schedule alarm' }, 500);
	}

	// Track in D1 for reconciliation (ntfy_topic kept for backward compat with old schema)
	await db.prepare(
		'INSERT OR REPLACE INTO scheduled_reminders (reminder_id, content, project, due_datetime, ntfy_topic) VALUES (?, ?, ?, ?, ?)'
	).bind(body.reminderId, body.content, body.project || null, body.dueDatetime, '').run();

	return corsResponse({ success: true });
}

export async function handleCancelReminder(request: Request, env: Env): Promise<Response> {
	const body = await request.json() as { reminderId?: string };

	if (!body.reminderId) {
		return corsResponse({ error: 'reminderId required' }, 400);
	}

	const db = env.DB;
	if (!db) return corsResponse({ error: 'Database not available' }, 404);

	await initDb(db);

	const id = env.REMINDER_ALARMS.idFromName(body.reminderId);
	const stub = env.REMINDER_ALARMS.get(id);
	await stub.fetch('https://do/cancel', { method: 'DELETE' });

	await db.prepare('DELETE FROM scheduled_reminders WHERE reminder_id = ?')
		.bind(body.reminderId).run();

	return corsResponse({ success: true });
}

export async function handleListScheduled(db: D1Database): Promise<Response> {
	await initDb(db);
	const rows = await queryRows(
		db.prepare('SELECT reminder_id, content, project, due_datetime, created_at FROM scheduled_reminders ORDER BY due_datetime ASC')
	);
	return corsResponse({ scheduled: rows });
}
