import { AUTH_TOKEN_KEY } from '../../config';
import { isReadingSession } from '../storage/storage-validation';

export const READING_SESSION_KEY = 'crate-reading-session-v1';
/** Window event for same-tab Reading session or storage changes; other tabs use `storage` events. */
export const READING_CHANGED_EVENT = 'crate-reading-change';
export interface ReadingSession { token: string; id: string; folderPath: string; generation: string; expiresAt: number; source?: 'reminders' }

export function readingSession(): ReadingSession | null {
	const raw = localStorage.getItem(READING_SESSION_KEY);
	if (!raw) return null;
	let value: unknown;
	try { value = JSON.parse(raw); } catch { throw new Error('Reading sign-in could not be read. Reconnect from Obsidian settings.'); }
	if (!isReadingSession(value)) throw new Error('Reading sign-in could not be read. Reconnect from Obsidian settings.');
	if (value.source === 'reminders' && localStorage.getItem(AUTH_TOKEN_KEY) !== value.token) return null;
	return value;
}
/** The same sign-in: identity, credential and server generation all match. */
export function sameReadingSession(current: ReadingSession | null | undefined, expected: ReadingSession): boolean {
	return current?.id === expected.id && current.token === expected.token && current.generation === expected.generation;
}
export function assertReadingSession(session: ReadingSession) {
	const current = readingSession();
	if (!sameReadingSession(current, session) || current?.folderPath !== session.folderPath) throw new Error('Reading sign-in changed. Reload this page.');
}
