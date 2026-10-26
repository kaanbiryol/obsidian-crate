import { describe, expect, it } from 'vitest';
import { READING_SHORTCUT_CONTRACT as shortcut } from '@/reading/shortcut';
import { apiRoutePolicy, apiRoutes } from './policy';
import { requestPlacement } from './placement';

const place = (method: string, path: string, running: 'public' | 'coordinator' | 'transfer') =>
	requestPlacement(apiRoutePolicy(path, method)?.execution, running, path === shortcut.preparePath);

describe('request placement', () => {
	it.each([
		['POST', '/reading/handoff', ['forward-grant', 'redeem-grant']],
		['POST', '/reminders/create', ['forward-before-auth', 'here']],
		['GET', '/reading/list', ['forward-before-auth', 'here']],
		['POST', shortcut.preparePath, ['forward-after-auth', 'here']],
		['PUT', '/sync/upload', ['forward-transfer', 'here']],
		['GET', '/sync/changes', ['here', 'here']],
	] as const)('runs %s %s at the edge, then in the coordinator, as %j', (method, path, [edge, coordinator]) => {
		expect(place(method, path, 'public')).toBe(edge);
		expect(place(method, path, 'coordinator')).toBe(coordinator);
	});

	it('handles a transfer that re-entered after queuing in its transfer object', () => {
		expect(place('PUT', '/sync/upload', 'transfer')).toBe('here');
		expect(place('POST', '/sync/batch-upload', 'transfer')).toBe('here');
	});

	it('never forwards from the coordinator, and forwards to it only coordinator and grant routes', () => {
		for (const { method, path } of apiRoutes()) {
			const execution = apiRoutePolicy(path, method)?.execution;
			expect(['here', 'redeem-grant'], `${method} ${path}`).toContain(place(method, path, 'coordinator'));
			const edge = place(method, path, 'public');
			if (edge.startsWith('forward-') && edge !== 'forward-transfer') expect(['coordinator', 'reading-grant'], `${method} ${path}`).toContain(execution?.kind);
			if (edge === 'forward-transfer') expect(execution?.kind, `${method} ${path}`).toBe('transfer');
		}
	});
});
