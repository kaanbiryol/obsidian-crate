import { expect, it } from 'vitest';
import { bindingIdentity, isD1DailyLimitError, withD1Usage } from './d1-usage';
import type { Env } from '../types';

it.each([
	'D1_ERROR: Exceeded daily rows written limit',
	'D1 exceeded its daily write limit',
	'Your account has exceeded D1’s free tier daily row read limit. Wait until midnight UTC.',
])('recognizes a D1 daily limit: %s', message => {
	expect(isD1DailyLimitError(new Error(message))).toBe(true);
});

it.each([
	'The daily request budget is exhausted. Try again tomorrow.',
	'Request body exceeded configured limit',
	'D1_ERROR: Exceeded maximum DB size',
])('leaves other failures alone: %s', message => {
	expect(isD1DailyLimitError(new Error(message))).toBe(false);
});

it('keeps one identity for a namespace however many requests wrap it', async () => {
	const namespace = { idFromName: () => ({}), get: () => ({ fetch: async () => new Response() }) };
	const DB = { prepare: () => ({}), batch: async () => [], exec: async () => ({}) };
	const seen: unknown[] = [];
	const nested = (env: Env) => withD1Usage(env, async inner => { seen.push(bindingIdentity(inner.REMINDER_ALARMS)); return new Response(); });
	for (let request = 0; request < 2; request++) {
		await withD1Usage({ DB, REMINDER_ALARMS: namespace } as unknown as Env, async env => {
			seen.push(bindingIdentity(env.REMINDER_ALARMS));
			return nested(env);
		});
	}
	expect(seen).toEqual([namespace, namespace, namespace, namespace]);
	expect(bindingIdentity(undefined)).toBeUndefined();
});
