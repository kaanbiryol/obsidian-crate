import { sendToAllSubscriptions } from './push';

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
			const body = await request.json() as ReminderData;
			await this.state.storage.put('reminder', body);
			const alarmTime = new Date(body.dueDatetime);
			await this.state.storage.setAlarm(alarmTime);
			return new Response(JSON.stringify({ success: true }));
		}

		if (method === 'DELETE') {
			await this.state.storage.deleteAlarm();
			await this.state.storage.deleteAll();
			return new Response(JSON.stringify({ success: true }));
		}

		if (method === 'GET') {
			const reminder = await this.state.storage.get('reminder');
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
