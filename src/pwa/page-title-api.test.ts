import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApiFetch } from './api';
import { invalidatePwaSession } from './session-generation';

beforeEach(() => {
	vi.stubGlobal('localStorage', { getItem: () => 'session' });
	vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
	vi.stubGlobal('navigator', { userAgent: 'Test Browser', maxTouchPoints: 0 });
});
afterEach(() => { invalidatePwaSession(); vi.unstubAllGlobals(); });
const options = () => ({ method: 'POST', body: JSON.stringify({ url: 'https://example.com/article' }), signal: AbortSignal.timeout(7000) });

describe('PWA page title requests', () => {
	it('authenticates the server request and passes its short timeout without compatibility requests', async () => {
		const network = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ title: 'Article' })); vi.stubGlobal('fetch', network);
		const init = options(); const result = await makeApiFetch('session-secret', vi.fn())('/links/title', init);
		expect(await result.json()).toEqual({ title: 'Article' }); expect(network).toHaveBeenCalledOnce();
		const [path, request] = network.mock.calls[0]!;
		expect(path).toBe('/links/title'); expect(request?.signal).toBe(init.signal); expect(request?.body).toBe(init.body);
		expect(new Headers(request?.headers).get('Authorization')).toBe('Bearer session-secret');
		expect(new Headers(request?.headers).get('Content-Type')).toBe('application/json');
	});
	it('does not send a URL when not authenticated', async () => {
		const network = vi.fn(); vi.stubGlobal('fetch', network);
		await expect(makeApiFetch(null, vi.fn())('/links/title', options())).rejects.toThrow('Not authenticated');
		expect(network).not.toHaveBeenCalled();
	});
	it('drops a late title after logout changes the session', async () => {
		let finish!: (response: Response) => void;
		vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
		const pending = makeApiFetch('old-session', vi.fn())('/links/title', options());
		invalidatePwaSession(); finish(Response.json({ title: 'Old session result' }));
		await expect(pending).rejects.toThrow('Session changed');
	});
	it('expires the session on 401, but leaves ordinary page lookup failures to the editor', async () => {
		const unauthorized = vi.fn(); const network = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(new Response(null, { status: 401 }));
		vi.stubGlobal('fetch', network); const api = makeApiFetch('session', unauthorized);
		expect((await api('/links/title', options())).status).toBe(404); expect(unauthorized).not.toHaveBeenCalled();
		await expect(api('/links/title', options())).rejects.toThrow('Session expired'); expect(unauthorized).toHaveBeenCalledOnce();
	});
});
