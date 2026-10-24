import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApiFetch } from './connection/api-fetch';
import { fetchPageTitle } from './reminders/reminder-api';
import { invalidatePwaSession } from './connection/session-generation';

vi.mock('./reminders/encryption-session', () => ({ prepareReminderEncryption: async () => null, reminderEncryptionSnapshot: () => ({ status: 'unencrypted' }) }));

beforeEach(() => {
	vi.stubGlobal('localStorage', { getItem: () => 'session' });
	vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
	vi.stubGlobal('navigator', { userAgent: 'Test Browser', maxTouchPoints: 0 });
});
afterEach(() => { invalidatePwaSession(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const url = 'https://example.com/article';

describe('PWA page title requests', () => {
	it('authenticates the server request and passes its short timeout without compatibility requests', async () => {
		const network = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ title: 'Article' })); vi.stubGlobal('fetch', network);
		const timeout = vi.spyOn(AbortSignal, 'timeout');
		expect(await fetchPageTitle(makeApiFetch('session-secret', vi.fn()), url)).toBe('Article'); expect(network).toHaveBeenCalledOnce();
		const [path, request] = network.mock.calls[0]!;
		expect(path).toBe('/links/title'); expect(request?.method).toBe('POST'); expect(request?.body).toBe(JSON.stringify({ url }));
		expect(timeout).toHaveBeenCalledExactlyOnceWith(7000); expect(request?.signal).toBe(timeout.mock.results[0]!.value);
		expect(new Headers(request?.headers).get('Authorization')).toBe('Bearer session-secret');
		expect(new Headers(request?.headers).get('Content-Type')).toBe('application/json');
	});
	it('ignores a response without a text title', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ title: 42 })));
		expect(await fetchPageTitle(makeApiFetch('session', vi.fn()), url)).toBeNull();
	});
	it('does not send a URL when not authenticated', async () => {
		const network = vi.fn(); vi.stubGlobal('fetch', network);
		await expect(fetchPageTitle(makeApiFetch(null, vi.fn()), url)).rejects.toThrow('Not authenticated');
		expect(network).not.toHaveBeenCalled();
	});
	it('drops a late title after logout changes the session', async () => {
		let finish!: (response: Response) => void;
		vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
		const pending = fetchPageTitle(makeApiFetch('old-session', vi.fn()), url);
		await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
		invalidatePwaSession(); finish(Response.json({ title: 'Old session result' }));
		await expect(pending).rejects.toThrow('Session changed');
	});
	it('expires the session on 401, but leaves ordinary page lookup failures to the editor', async () => {
		const unauthorized = vi.fn(); const network = vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(new Response(null, { status: 401 }));
		vi.stubGlobal('fetch', network); const api = makeApiFetch('session', unauthorized);
		expect(await fetchPageTitle(api, url)).toBeNull(); expect(unauthorized).not.toHaveBeenCalled();
		await expect(fetchPageTitle(api, url)).rejects.toThrow('Session expired'); expect(unauthorized).toHaveBeenCalledOnce();
	});
});
