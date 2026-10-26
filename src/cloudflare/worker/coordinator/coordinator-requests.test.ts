import { expect, it, vi } from 'vitest';
vi.mock('../maintenance/schedule', () => ({ scheduleMaintenance: vi.fn(async () => {}) }));
vi.mock('../request-handler', () => ({ fetchWorkerRequest: vi.fn(async () => new Response(null, { status: 204 })) }));
import { handleCoordinatorRequest } from './coordinator-requests';
import { INTERNAL_MUTATION_HEADER } from './coordinator';
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
