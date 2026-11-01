import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connectReadingFromReminders, prefetchReadingSession } from './api';
import { AUTH_TOKEN_KEY } from '../config';
import { READING_SESSION_KEY } from './session/session';

vi.mock('./session/encryption-session', () => ({ prepareReadingEncryption: async () => null, readingEncryptionHeaders: () => ({}), readingKeys: () => null }));

const values = new Map<string, string>();
const network = vi.fn<typeof fetch>();
const answer = () => Response.json({ id: 'token-id', folderPath: 'Reading', generation: 'one', expiresAt: 1, day: 20_000 });
beforeEach(() => {
	values.clear(); network.mockReset().mockImplementation(async () => answer());
	values.set(AUTH_TOKEN_KEY, 'reminders-token');
	vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
	vi.stubGlobal('window', { dispatchEvent: vi.fn() });
	vi.stubGlobal('fetch', network);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('applies a session check started early once, when the refresh asks for it', async () => {
	prefetchReadingSession();
	expect(network).toHaveBeenCalledOnce();
	// Starting it applies nothing: the session is written by the call that uses the answer.
	expect(values.has(READING_SESSION_KEY)).toBe(false);
	await expect(connectReadingFromReminders()).resolves.toMatchObject({ session: { token: 'reminders-token', generation: 'one' }, day: 20_000 });
	expect(network).toHaveBeenCalledOnce();
	// A later refresh asks the server again.
	await connectReadingFromReminders();
	expect(network).toHaveBeenCalledTimes(2);
});

it('does not reuse an early check that failed, went stale or belongs to another credential', async () => {
	network.mockResolvedValueOnce(Response.json({ error: 'Unavailable' }, { status: 503 }));
	prefetchReadingSession();
	await new Promise(resolve => setTimeout(resolve, 0));
	await expect(connectReadingFromReminders()).resolves.toMatchObject({ day: 20_000 });
	expect(network).toHaveBeenCalledTimes(2);

	prefetchReadingSession();
	const started = Date.now();
	vi.spyOn(Date, 'now').mockReturnValue(started + 11_000);
	await connectReadingFromReminders();
	expect(network).toHaveBeenCalledTimes(4);
	vi.restoreAllMocks();

	prefetchReadingSession();
	values.set(AUTH_TOKEN_KEY, 'other-token');
	await connectReadingFromReminders();
	expect(network).toHaveBeenCalledTimes(6);
	expect(new Headers(network.mock.calls[5]![1]!.headers).get('Authorization')).toBe('Bearer other-token');
});
