import { sendToAllSubscriptions } from './push';
import { parseJsonObject, parseOptionalString, parseNonNegativeInteger } from './utils';

interface ReminderData {
	reminderId: string;
	content: string;
	project?: string;
	dueDatetime: string;
	priority?: number;
}

export class ReminderAlarm implements DurableObject {
	constructor(
		private state: DurableObjectState,
		private env: { DB: D1Database | null },
	) {}

	async fetch(request: Request): Promise<Response> {
		const method = request.method;

		if (method === 'PUT') {
			const parsedBody = await parseJsonObject(request);
			if (!parsedBody.ok) {
				return parsedBody.response;
			}

			const reminderId = parseOptionalString(parsedBody.value.reminderId, 256);
			const content = parseOptionalString(parsedBody.value.content, 1024);
			const dueDatetime = parseOptionalString(parsedBody.value.dueDatetime, 128);
			const project = parsedBody.value.project === undefined
				? undefined
				: parseOptionalString(parsedBody.value.project, 256) || undefined;
			const priority = parsedBody.value.priority === undefined
				? undefined
				: parseNonNegativeInteger(parsedBody.value.priority) ?? undefined;
			if (!reminderId || !content || !dueDatetime) {
				return new Response(JSON.stringify({ error: 'Invalid reminder payload' }), { status: 400 });
			}

			const alarmTime = new Date(dueDatetime);
			if (Number.isNaN(alarmTime.getTime())) {
				return new Response(JSON.stringify({ error: 'Invalid dueDatetime' }), { status: 400 });
			}
			if (alarmTime.getTime() <= Date.now()) {
				return new Response(JSON.stringify({ error: 'dueDatetime must be in the future' }), { status: 400 });
			}
			const body: ReminderData = { reminderId, content, dueDatetime, project, priority };
			await this.state.storage.put('reminder', body);
			await this.state.storage.setAlarm(alarmTime);
			return new Response(JSON.stringify({ success: true }));
		}

		if (method === 'DELETE') {
			await this.state.storage.deleteAlarm();
			await this.state.storage.deleteAll();
			return new Response(JSON.stringify({ success: true }));
		}

		if (method === 'GET') {
			const reminder = await this.state.storage.get<ReminderData>('reminder');
			const alarm = await this.state.storage.getAlarm();
			return new Response(JSON.stringify({ reminder, alarmTime: alarm }));
		}

		return new Response('Method not allowed', { status: 405 });
	}

	async alarm(): Promise<void> {
		const reminder = await this.state.storage.get<ReminderData>('reminder');
		if (!reminder) return;

		const db = this.env.DB;
		if (db) {
			try {
				await sendToAllSubscriptions(db, {
					title: reminder.content,
					body: reminder.project || '',
					tag: reminder.reminderId,
					project: reminder.project,
				});
			} catch (err) {
				console.error('ReminderAlarm: push failed', reminder.reminderId, err);
			}

			// Clean up D1 record
			try {
				await db.prepare('DELETE FROM scheduled_reminders WHERE reminder_id = ?')
					.bind(reminder.reminderId).run();
			} catch { /* non-fatal */ }
		}

		// Clean up DO storage
		await this.state.storage.deleteAll();
	}
}
