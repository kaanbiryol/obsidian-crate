import { armNotificationCoordinator } from './notification-lifecycle';
import { fetchWorkerRequest } from './request-handler';
import { REMINDER_CACHE_PARSER_VERSION } from './reminders-web/reminder-cache/types';
import type { Env } from './types';

/** Internal endpoints; the caller holds the Durable Object's mutation lock. */
export async function handleCoordinatorRequest(request: Request, state: DurableObjectState, env: Env): Promise<Response | null> {
	if (request.headers.get('X-Crate-Internal-Mutation') === '1') {
		const maintenance = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/maintenance'));
		const response = await maintenance.fetch('https://do/maintain', { method: 'POST' });
		if (!response.ok) throw new Error('Unable to schedule server cleanup');
		const original = new Request(request);
		original.headers.delete('X-Crate-Internal-Mutation');
		return fetchWorkerRequest(original, env, state);
	}
	if (new URL(request.url).pathname === '/maintain' && request.method === 'POST') {
		await state.storage.put('maintenanceCoordinator', true);
		if (await state.storage.getAlarm() === null) {
      await state.storage.put('maintenancePass', 0);
      await state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
    }
		return new Response(null, { status: 204 });
	}
	if (new URL(request.url).pathname === '/ensure' && request.method === 'POST') {
		if (await state.storage.get<number>('projectionParserVersion') !== REMINDER_CACHE_PARSER_VERSION) {
			await armNotificationCoordinator(state);
			await state.storage.put('projectionParserVersion', REMINDER_CACHE_PARSER_VERSION);
		}
		return new Response(null, { status: 204 });
	}

	if (new URL(request.url).pathname === '/project' && request.method === 'POST') {
		await armNotificationCoordinator(state);
		return new Response(JSON.stringify({ success: true }));
	}

  return null;
}
