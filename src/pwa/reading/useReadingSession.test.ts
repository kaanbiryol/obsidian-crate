import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { useReadingConnection } from './session/useReadingConnection';
import { useReadingSession } from './useReadingSession';
import { AUTH_TOKEN_KEY } from '../config';
import { adoptEarlierReadingCaptures, newestReadingShare, readReadingCache, readReadingDraft, readReadingShare, removeReadingShare, saveReadingDraft } from './storage/storage';
import { READING_SESSION_KEY, type ReadingSession } from './session/session';
import { connectReadingFromReminders } from './api';
import { prepareReadingEncryption } from './session/encryption-session';
import { EncryptionVerificationUnavailableError } from '../connection/encryption';

vi.mock('./session/encryption-session', () => ({ prepareReadingEncryption: vi.fn(async () => null), readingKeys: () => null, resetReadingEncryption: vi.fn(), readingEncryptionHeaders: () => ({}), onReadingEncryptionReset: vi.fn() }));
vi.mock('../service-worker-registration', () => ({ registerPwaServiceWorker: vi.fn(async () => null) }));
vi.mock('./api', async importOriginal => ({
	...await importOriginal<typeof import('./api')>(), connectReadingFromReminders: vi.fn(async () => null),
}));
vi.mock('./storage/storage', async importOriginal => ({
	...await importOriginal<typeof import('./storage/storage')>(),
	readReadingCache: vi.fn(async () => undefined), pendingReading: vi.fn(async () => []),
	readReadingDraft: vi.fn(async () => undefined), readReadingShare: vi.fn(async () => undefined), hasEarlierReadingChanges: vi.fn(async () => false),
	saveReadingDraft: vi.fn(async () => {}), removeReadingShare: vi.fn(async () => {}), newestReadingShare: vi.fn(async () => undefined),
	adoptEarlierReadingCaptures: vi.fn(async () => {}),
}));

const session: ReadingSession = { token: 'enrolled-token', id: 'enrolled-session', folderPath: 'Reading', generation: 'one', expiresAt: 1 };
const replacement = { ...session, token: 'replacement-token', id: 'replacement-session' };
const values = new Map<string, string>();
const network = vi.fn<typeof fetch>();
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
beforeEach(() => {
	values.clear(); vi.clearAllMocks(); network.mockReset().mockImplementation(async () => new Response(null, { status: 204 }));
	vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
	vi.stubGlobal('navigator', { onLine: true });
	vi.stubGlobal('location', { hash: '', href: 'https://example.test/notifications?section=reading' });
	vi.stubGlobal('fetch', network);
});
function renderSession() {
	return renderHook(() => useReadingSession(useReadingConnection(true, true)), () => {
		Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) });
	});
}
function start() {
	const connected = deferred<ReadingSession>();
	localStorage.setItem(AUTH_TOKEN_KEY, 'reminders');
	vi.mocked(connectReadingFromReminders).mockImplementationOnce(async () => {
		const next = await connected.promise;
		localStorage.setItem(READING_SESSION_KEY, JSON.stringify(next));
		return { session: next };
	});
	return { rendered: renderSession(), release: connected.resolve };
}

describe('Reading session authority', () => {
	it.each(['replacement', 'reset', 'unmount'] as const)('rejects stale state publications after %s', async change => {
		const h = start();
		await act(async () => { h.release(session); });
		const publisher = h.rendered.current;
		expect(publisher.isCurrentSession(session)).toBe(true);
		await act(async () => {
			if (change === 'replacement') localStorage.setItem(READING_SESSION_KEY, JSON.stringify(replacement));
			if (change === 'reset') publisher.resetSession();
		});
		if (change === 'unmount') h.rendered.unmount();
		const before = h.rendered.current;
		await act(async () => {
			expect(publisher.publishPending(session, [{ id: 'stale', sessionId: session.id, action: 'retry', intent: { id: 'article' } }])).toBe(false);
			expect(publisher.publishSyncResult(session, { pending: [], cache: { items: [], issues: [], savedAt: 99 }, completed: true })).toBe(false);
			expect(publisher.finishCapture(session)).toBe(false);
			publisher.reportSessionError(session, 'A stale failure');
		});
		expect(h.rendered.current).toMatchObject({ cache: before.cache, pending: before.pending, error: before.error, url: before.url });
	});

	it('connects from Reminders, hydrates a saved draft, and saves edits after rerender', async () => {
		vi.mocked(readReadingDraft).mockResolvedValueOnce({ url: 'https://saved.example/article' });
		const h = start();
		await act(async () => { h.release(session); });
		expect(h.rendered.current).toMatchObject({ ready: true, session, adding: true, url: 'https://saved.example/article' });
		expect(connectReadingFromReminders).toHaveBeenCalledOnce();
		await act(async () => h.rendered.current.setUrl('https://edited.example/article'));
		expect(saveReadingDraft).toHaveBeenLastCalledWith(session, { url: 'https://edited.example/article' });
	});

	it('fences delayed hydration after reset and preserves an unreadable draft', async () => {
		const cache = deferred<undefined>();
		vi.mocked(readReadingCache).mockReturnValueOnce(cache.promise);
		const h = start();
		await act(async () => { h.release(session); });
		await act(async () => h.rendered.current.resetSession());
		await act(async () => { cache.resolve(undefined); });
		expect(h.rendered.current.session).toBeNull();
		expect(saveReadingDraft).not.toHaveBeenCalled();
		h.rendered.unmount();

		vi.mocked(readReadingDraft).mockRejectedValueOnce(new Error('Saved draft needs recovery'));
		const damaged = start();
		await act(async () => { damaged.release(session); });
		expect(damaged.rendered.current).toMatchObject({ session, recovery: true, error: 'Saved draft needs recovery' });
		expect(saveReadingDraft).not.toHaveBeenCalled();
	});

	it('does not restore a connection when encryption finishes after reset', async () => {
		const encryption = deferred<null>();
		vi.mocked(prepareReadingEncryption).mockReturnValueOnce(encryption.promise);
		const h = start();
		await act(async () => { h.release(session); });
		await act(async () => h.rendered.current.resetSession());
		await act(async () => encryption.resolve(null));
		expect(h.rendered.current.session).toBeNull();
		expect(readReadingCache).not.toHaveBeenCalled();
	});

	it('retries an unavailable encryption check when the app comes back online', async () => {
		vi.mocked(prepareReadingEncryption).mockRejectedValueOnce(new EncryptionVerificationUnavailableError('Could not verify encryption. Check your connection and retry.'));
		const h = start();
		await act(async () => { h.release(session); });
		expect(h.rendered.current).toMatchObject({ session: null, lockedSession: session, verificationUnavailable: true });
		await act(async () => window.dispatchEvent(new window.Event('online')));
		expect(h.rendered.current).toMatchObject({ session, lockedSession: null, verificationUnavailable: false });
		expect(prepareReadingEncryption).toHaveBeenCalledTimes(2);
	});

	it('hydrates the plaintext offline copy read-only when an unanswered check finds no encryption evidence', async () => {
		const cache = { items: [], issues: [], savedAt: 5 };
		// Read once read-only, then again after the check is answered.
		vi.mocked(readReadingCache).mockResolvedValueOnce(cache).mockResolvedValueOnce(cache);
		vi.mocked(readReadingDraft).mockResolvedValueOnce({ url: 'https://saved.example/draft' }).mockResolvedValueOnce({ url: 'https://saved.example/draft' });
		vi.mocked(prepareReadingEncryption).mockRejectedValueOnce(new EncryptionVerificationUnavailableError('Could not verify encryption. Check your connection and retry.', undefined, true));
		const h = start();
		await act(async () => { h.release(session); });
		// Before: an unanswered check hid the saved library behind a full-screen error.
		expect(h.rendered.current).toMatchObject({ ready: true, session, readOnly: true, lockedSession: session, cache, adding: false, url: '' });
		expect(saveReadingDraft).not.toHaveBeenCalled();
		expect(adoptEarlierReadingCaptures).not.toHaveBeenCalled();
		expect(readReadingShare).not.toHaveBeenCalled();
		await act(async () => window.dispatchEvent(new window.Event('online')));
		expect(h.rendered.current).toMatchObject({ session, readOnly: false, lockedSession: null, adding: true, url: 'https://saved.example/draft' });
		expect(adoptEarlierReadingCaptures).toHaveBeenCalledWith(session);
	});

	it('copies a shared link into the draft and removes its staged record, so dismissing keeps only the draft', async () => {
		vi.stubGlobal('location', { hash: '', href: 'https://example.test/notifications?section=reading&share=shared' });
		vi.mocked(readReadingShare).mockResolvedValueOnce({ url: 'https://shared.example/article' });
		const h = start();
		await act(async () => { h.release(session); });
		expect(h.rendered.current).toMatchObject({ adding: true, url: 'https://shared.example/article' });
		expect(saveReadingDraft).toHaveBeenCalledWith(session, { url: 'https://shared.example/article' });
		expect(removeReadingShare).toHaveBeenCalledExactlyOnceWith(session, 'shared');
		act(() => h.rendered.current.closeCapture());
		expect(h.rendered.current).toMatchObject({ adding: false, url: 'https://shared.example/article' });
		expect(newestReadingShare).not.toHaveBeenCalled();
	});

	it.each([[undefined, true], [{ url: 'https://saved.example/draft' }, false]])('takes the newest staged share after enrollment replaced the link (draft %o)', async (draft, taken) => {
		vi.mocked(readReadingDraft).mockResolvedValueOnce(draft);
		vi.mocked(newestReadingShare).mockResolvedValueOnce({ id: 'before-enrollment', url: 'https://shared.example/early' });
		const h = start();
		await act(async () => { h.release(session); });
		expect(h.rendered.current).toMatchObject({ adding: true, url: taken ? 'https://shared.example/early' : 'https://saved.example/draft' });
		// A draft link is never replaced by a share the user did not just send.
		expect(newestReadingShare).toHaveBeenCalledTimes(taken ? 1 : 0);
		expect(removeReadingShare).toHaveBeenCalledTimes(taken ? 1 : 0);
	});

	it('removes connection listeners after enrollment and on unmount', async () => {
		localStorage.setItem(AUTH_TOKEN_KEY, 'reminders');
		const rendered = renderSession();
		await act(async () => {});
		expect(connectReadingFromReminders).toHaveBeenCalledOnce();
		vi.mocked(connectReadingFromReminders).mockImplementationOnce(async () => {
			localStorage.setItem(READING_SESSION_KEY, JSON.stringify(session)); return { session };
		});
		await act(async () => window.dispatchEvent(new window.Event('online')));
		expect(rendered.current.session).toEqual(session);
		vi.mocked(connectReadingFromReminders).mockClear();
		await act(async () => window.dispatchEvent(new window.Event('online')));
		expect(connectReadingFromReminders).not.toHaveBeenCalled();
		rendered.unmount();
		window.dispatchEvent(new window.Event('online'));
		expect(connectReadingFromReminders).not.toHaveBeenCalled();
	});
});
