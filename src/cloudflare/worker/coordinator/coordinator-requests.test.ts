import { expect, it, vi } from 'vitest';
vi.mock('../maintenance/schedule', () => ({ scheduleMaintenance: vi.fn(async () => {}) }));
vi.mock('../request-handler', () => ({ fetchWorkerRequest: vi.fn(async () => new Response(null, { status: 204 })) }));
import { handleCoordinatorRequest } from './coordinator-requests';
import { COORDINATOR_PATHS, INTERNAL_MUTATION_HEADER } from './coordinator';
import { scheduleMaintenance } from '../maintenance/schedule';
import type { Env } from '../types';

it.each([
	['GET', '/reading/list', false],
	['GET', '/encryption/reset', false],
	['PUT', '/settings', true],
	['POST', '/reminders/update', true],
])('%s %s forwarded to the coordinator arms cleanup only for a mutation', async (method, path, arms) => {
	vi.mocked(scheduleMaintenance).mockClear();
	const request = new Request(`https://test${path}`, { method, headers: { [INTERNAL_MUTATION_HEADER]: '1' } });
	const response = await handleCoordinatorRequest(request, {} as DurableObjectState, {} as Env,
		action => action(), async () => new Response(null, { status: 404 }));
	expect(response.status).toBe(204);
	expect(scheduleMaintenance).toHaveBeenCalledTimes(arms ? 1 : 0);
});

it('revokes a credential only while holding the coordinator lock', async () => {
	let locked = false;
	const statements: string[] = [];
	const db = {
		prepare: (sql: string) => ({ bind: () => sql }),
		batch: vi.fn(async (batch: string[]) => {
			expect(locked).toBe(true);
			statements.push(...batch);
			return [{ meta: { changes: 1 } }, { meta: { changes: 0 } }, { meta: { changes: 1 } }];
		}),
	};
	const request = new Request(`https://do${COORDINATOR_PATHS.revokeCredential}`, { method: 'POST', body: JSON.stringify({ id: 'device' }) });
	const response = await handleCoordinatorRequest(request, {} as DurableObjectState, { DB: db } as unknown as Env, async action => {
		locked = true;
		try { return await action(); } finally { locked = false; }
	}, async () => new Response(null, { status: 404 }));
	expect(await response.json()).toEqual({ revoked: true });
	expect(statements).toEqual([
		'DELETE FROM push_subscriptions WHERE owner_token_id IN (?)',
		"DELETE FROM auth_tokens WHERE scope = 'reading_capture' AND device_id IN (?)",
		'DELETE FROM auth_tokens WHERE id IN (?)',
	]);
});
