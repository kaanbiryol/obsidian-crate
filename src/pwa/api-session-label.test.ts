import { afterEach, expect, it, vi } from 'vitest';
import { CRATE_WEB_SESSION_NAME_HEADER } from '../protocol/web-session';
import { exchangeEnrollmentToken, makeApiFetch } from './api';

vi.mock('./server-compatibility', () => ({ requireCompatibleServer: vi.fn().mockResolvedValue({ protocol: { current: 7, oldestCompatible: 7 } }) }));
afterEach(() => vi.unstubAllGlobals());

it.each([false, true])('reports a session label during enrollment and existing-session requests (standalone=%s)', async standalone => {
	vi.stubGlobal('navigator', {
		userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) Version/26.0 Mobile/15E148 Safari/604.1',
		maxTouchPoints: 5,
		standalone,
	});
	vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
	const network = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ authToken: 'new-session' })));
	vi.stubGlobal('fetch', network);
	const name = standalone ? 'iPhone · Home Screen app' : 'iPhone · Safari';

	await exchangeEnrollmentToken('enrollment-grant');
	expect(network).toHaveBeenLastCalledWith('/notifications/reminders-exchange', expect.objectContaining({
		body: JSON.stringify({ token: 'enrollment-grant', deviceName: name }),
	}));
	// Existing sessions can report the label without another enrollment.
	await makeApiFetch('existing-session', vi.fn())('/reminders/list?folderPath=Reminders');
	const request = network.mock.calls.at(-1)!;
	const headers = new Headers(request[1]?.headers);
	expect(headers.get(CRATE_WEB_SESSION_NAME_HEADER)).toBe(encodeURIComponent(name));
	expect(headers.get('Authorization')).toBe('Bearer existing-session');
});
