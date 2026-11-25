/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from 'cloudflare:workers';
import { listDurableObjectIds, reset, runDurableObjectAlarm } from 'cloudflare:test';

/** Alarms an object may set for itself while it settles, such as a retry. */
const MAX_ALARM_RUNS = 10;

/**
 * Deletes every binding's data, like `reset()`, once pending alarms have run. A request can
 * leave an alarm a millisecond away (the notification coordinator does); `reset()` racing that
 * alarm's D1 queries can leave the previous test's rows behind for the next one.
 */
export async function resetAfterAlarms(): Promise<void> {
	for (const id of await listDurableObjectIds(env.REMINDER_ALARMS)) {
		const stub = env.REMINDER_ALARMS.get(id);
		for (let run = 0; run < MAX_ALARM_RUNS && await runDurableObjectAlarm(stub); run++) { /* Run the next alarm. */ }
	}
	await reset();
}
