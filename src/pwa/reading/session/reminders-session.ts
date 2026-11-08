// Signs into Reading with the Reminders credential, without the Reading request client.
import { reportExpiredConnection } from '../../connection/expiration';
import { AUTH_TOKEN_KEY } from '../../config';
import { capturePwaSession } from '../../connection/session-generation';
import { requestSharedFeaturesRefresh } from '../../shared-features';
import { responseError } from '../../connection/response-error';
import { crateRequestHeaders } from '../../connection/request-headers';
import { READING_CHANGED_EVENT, READING_SESSION_KEY, readingSession, type ReadingSession } from './session';
import { ReadingApiError } from './api-error';

interface SessionAnswer { token: string; sessionCurrent: () => boolean; status: number; ok: boolean; failure: { message: string; code?: string } | null; data: { id?: unknown; folderPath?: unknown; generation?: unknown; expiresAt?: unknown; day?: unknown } | null }
async function requestReadingSession(token: string): Promise<SessionAnswer> {
	const sessionCurrent = capturePwaSession();
	const response = await fetch('/reading/session', { cache: 'no-store', signal: AbortSignal.timeout(20_000),
		headers: crateRequestHeaders(token) });
	const failure = response.ok ? null : await responseError(response, 'Reading is unavailable.');
	const data = failure ? null : await response.json().catch(() => null) as SessionAnswer['data'];
	return { token, sessionCurrent, status: response.status, ok: response.ok, failure, data };
}

// A session check started while the encryption check runs, for the refresh that follows.
const EARLY_SESSION_MAX_AGE_MS = 10_000;
let earlySession: { token: string; startedAt: number; answer: Promise<SessionAnswer> } | undefined;
/** Starts the next `connectReadingFromReminders` request now. Only its network request
 * runs early; the call that uses the answer applies it, as before. */
export function prefetchReadingSession(): void {
	const token = localStorage.getItem(AUTH_TOKEN_KEY);
	if (!token) return;
	const entry = { token, startedAt: Date.now(), answer: requestReadingSession(token) };
	earlySession = entry;
	// A failed check is never reused; the next caller asks again.
	entry.answer.then(answer => { if (!answer.ok && earlySession === entry) earlySession = undefined; }, () => { if (earlySession === entry) earlySession = undefined; });
}

/** The Reminders credential's Reading session. `day` is the server's operation day
 * from the same response, so a drain right after it need not ask again. */
export async function connectReadingFromReminders(): Promise<{ session: ReadingSession; day?: number } | null> {
	const token = localStorage.getItem(AUTH_TOKEN_KEY);
	if (!token) return null;
	const early = earlySession; earlySession = undefined;
	const { sessionCurrent, status, failure, data } = await (early?.token === token && Date.now() - early.startedAt < EARLY_SESSION_MAX_AGE_MS
		? early.answer : requestReadingSession(token));
	if (!sessionCurrent() || localStorage.getItem(AUTH_TOKEN_KEY) !== token) {
		const stored = readingSession();
		return stored && { session: stored };
	}
	if (status === 401) reportExpiredConnection(token);
	if (status === 423) requestSharedFeaturesRefresh(true);
	if (failure) throw new ReadingApiError(failure.message, status, failure.code);
	if (!data || typeof data.id !== 'string' || !data.id || typeof data.folderPath !== 'string' || !data.folderPath
		|| typeof data.generation !== 'string' || !data.generation || typeof data.expiresAt !== 'number' || !Number.isFinite(data.expiresAt)) {
		throw new Error('The server returned an invalid Reading session.');
	}
	const day = typeof data.day === 'number' && Number.isSafeInteger(data.day) && data.day >= 0 ? data.day : undefined;
	const existing = readingSession();
	if (existing?.token === token && existing.generation === data.generation) return { session: existing, day };
	const next: ReadingSession = { token, id: `reminders:${data.id}:${data.generation}`, folderPath: data.folderPath,
		generation: data.generation, expiresAt: data.expiresAt };
	localStorage.setItem(READING_SESSION_KEY, JSON.stringify(next));
	window.dispatchEvent(new Event(READING_CHANGED_EVENT));
	return { session: next, day };
}
