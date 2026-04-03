import { corsResponse } from './cors';
import { initDb, queryRows } from './db';
import type { Env } from './types';
import { parseJsonObject, parseNonNegativeInteger, parseOptionalString } from './utils';

export async function handleScheduleReminder(request: Request, env: Env): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const reminderId = parseOptionalString(parsedBody.value.reminderId, 256);
	const content = parseOptionalString(parsedBody.value.content, 1024);
	const dueDatetime = parseOptionalString(parsedBody.value.dueDatetime, 128);
	const project = parsedBody.value.project === undefined
		? null
		: parseOptionalString(parsedBody.value.project, 256);
	const priority = parsedBody.value.priority === undefined
		? undefined
		: parseNonNegativeInteger(parsedBody.value.priority);

	if (!reminderId || !content || !dueDatetime) {
		return corsResponse({ error: 'reminderId, content, and dueDatetime required' }, 400);
	}
	if (parsedBody.value.project !== undefined && project === null) {
		return corsResponse({ error: 'Invalid project' }, 400);
	}
	if (parsedBody.value.priority !== undefined && priority === null) {
		return corsResponse({ error: 'Invalid priority' }, 400);
	}

	const dueDate = new Date(dueDatetime);
	if (Number.isNaN(dueDate.getTime())) {
		return corsResponse({ error: 'Invalid dueDatetime' }, 400);
	}
	if (dueDate.getTime() <= Date.now()) {
		return corsResponse({ error: 'dueDatetime must be in the future' }, 400);
	}

	const db = env.DB;
	if (!db) return corsResponse({ error: 'Database not available' }, 503);

	await initDb(db);

	// Create/update Durable Object alarm
	const id = env.REMINDER_ALARMS.idFromName(reminderId);
	const stub = env.REMINDER_ALARMS.get(id);
	const doResp = await stub.fetch('https://do/schedule', {
		method: 'PUT',
		body: JSON.stringify({
			reminderId,
			content,
			project: project || undefined,
			dueDatetime,
			priority,
		}),
	});

	if (!doResp.ok) {
		return corsResponse({ error: 'Failed to schedule alarm' }, 500);
	}

	// Track in D1 for reconciliation.
	await db.prepare(
		'INSERT OR REPLACE INTO scheduled_reminders (reminder_id, content, project, due_datetime) VALUES (?, ?, ?, ?)'
	).bind(reminderId, content, project, dueDatetime).run();

	return corsResponse({ success: true });
}

export async function handleCancelReminder(request: Request, env: Env): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const reminderId = parseOptionalString(parsedBody.value.reminderId, 256);

	if (!reminderId) {
		return corsResponse({ error: 'reminderId required' }, 400);
	}

	const db = env.DB;
	if (!db) return corsResponse({ error: 'Database not available' }, 503);

	await initDb(db);

	const id = env.REMINDER_ALARMS.idFromName(reminderId);
	const stub = env.REMINDER_ALARMS.get(id);
	let response: Response;
	try {
		response = await stub.fetch('https://do/cancel', { method: 'DELETE' });
	} catch {
		return corsResponse({ error: 'Failed to cancel alarm' }, 500);
	}
	if (!response.ok) {
		return corsResponse({ error: 'Failed to cancel alarm' }, 500);
	}

	await db.prepare('DELETE FROM scheduled_reminders WHERE reminder_id = ?')
		.bind(reminderId).run();

	return corsResponse({ success: true });
}

export async function handleListScheduled(db: D1Database): Promise<Response> {
	await initDb(db);
	const rows = await queryRows(
		db.prepare('SELECT reminder_id, content, project, due_datetime, created_at FROM scheduled_reminders ORDER BY due_datetime ASC')
	);
	return corsResponse({ scheduled: rows });
}
