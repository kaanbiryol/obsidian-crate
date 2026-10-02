import { hasEncryptedSessionEvidence, parseScopedEncryptionState, type ScopedEncryptionState } from './encryption-scope';
import type { StoredReminderKeys } from './encryption-keys';
import { requirePrivateStorageUnlock, unlockPrivateStorage, lockPrivateStorage, useUnencryptedStorage } from './private-storage';
import { capturePwaSession } from './session-generation';
import { AUTH_TOKEN_KEY, loadStoredConfig } from './config';
import type { ApiFetch } from './types';

type ScopeState = ScopedEncryptionState;
type EncryptionView = { status: 'checking' | 'legacy' } | { status: 'ready'; folderPath: string }
	| { status: 'locked'; message: string; converting: boolean };
let view: EncryptionView = { status: 'checking' };
const listeners = new Set<() => void>();
let pending: { token: string; promise: Promise<StoredReminderKeys | null> } | undefined;
let state: ScopeState | undefined;
let fragmentCode: string | undefined;

export const subscribeEncryption = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const encryptionSnapshot = () => view;
function publish(next: EncryptionView) { view = next; for (const listener of listeners) listener(); }

/** Fragments never travel in HTTP requests, cookies, manifests or referrers. */
export function consumeEncryptionFragment(): void {
	const fragment = new URLSearchParams(window.location.hash.slice(1));
	const code = fragment.get('crateKey');
	if (!code) return;
	fragmentCode = code;
	fragment.delete('crateKey');
	window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + (fragment.size ? '#' + fragment.toString() : ''));
}

async function markerKey(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return 'crate-encryption-session:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function matches(keys: StoredReminderKeys, expected: ScopeState): boolean {
	return keys.version === 1 && keys.vaultId === expected.vaultId && keys.scopeId === expected.scope.id
		&& keys.folderPath === expected.scope.folderPath && keys.generation === expected.generation
		&& keys.data.id === expected.scope.keyId && keys.notifications.id === expected.scope.notificationKeyId;
}

export function resetPwaEncryption(discardKeys = false): void {
	pending = undefined; state = undefined;
	if (discardKeys) fragmentCode = undefined;
	lockPrivateStorage();
	publish({ status: 'checking' });
}

export function preparePwaEncryption(token: string, rawFetch: ApiFetch, refresh = false): Promise<StoredReminderKeys | null> {
	if (refresh) pending = undefined;
	if (pending?.token === token) return pending.promise;
	const sessionCurrent = capturePwaSession();
	const current = () => sessionCurrent() && pending?.promise === work;
	// Keep the last confirmed state during a same-session refresh. Initial
	// startup and reset already publish checking; changing it here races push
	// provider selection against an ordinary concurrent reminder-list request.
	const work = (async () => {
		const marker = await markerKey(token);
		const remembered = localStorage.getItem(marker);
		let expected: ScopeState | null;
		try {
			const response = await rawFetch('/encryption');
			if (!response.ok && response.status !== 404) throw new Error('Could not check encryption for this enrollment');
			const result = response.status === 404 ? { encryption: null } : await response.json() as { encryption: unknown };
			expected = result.encryption === null ? null : parseScopedEncryptionState(result.encryption, 'reminders');
			if (!expected && hasEncryptedSessionEvidence(remembered, fragmentCode)) throw new Error('The server no longer reports this vault’s encryption configuration. Reconnect from Obsidian before syncing.');
		} catch (error) {
			// An already trusted device can reopen offline using its authenticated
			// enrollment metadata. Online failures never downgrade encryption.
			if (typeof navigator !== 'undefined' && navigator.onLine === false) {
				if (!remembered && hasEncryptedSessionEvidence(remembered, fragmentCode)) throw new Error('Go online once to verify this encrypted enrollment');
				expected = remembered ? parseScopedEncryptionState(JSON.parse(remembered), 'reminders') : null;
			}
			else throw error;
		}
		if (!current()) throw new Error('Session changed before unlocking');
		if (!expected) {
			useUnencryptedStorage();
			state = undefined;
			publish({ status: 'legacy' });
			return null;
		}
		state = expected;
		localStorage.setItem(marker, JSON.stringify(expected));
		if (view.status !== 'ready') requirePrivateStorageUnlock();
		if (expected.mode !== 'active') throw new Error(expected.mode === 'resetting'
			? 'Encryption reset is in progress. Resume it in Obsidian, then log out here and use a fresh enrollment link.'
			: 'Encryption conversion is in progress. Resume it in Obsidian.');
		const localFolder = loadStoredConfig().folderPath;
		const { readReminderKeys, unlockLocalState, followEncryptionScope } = await import('./encryption-keys');
		if (fragmentCode) {
			const { rememberWebAppKey } = await import('./web-app-unlock');
			await rememberWebAppKey(fragmentCode, expected, localFolder, current); fragmentCode = undefined;
		}
		let keys = await readReminderKeys(expected.vaultId, expected.scope.id);
		if (!keys) throw new Error('Unlock this device with the web app key from Crate in Obsidian.');
		keys = await followEncryptionScope(keys, expected, localFolder, current);
		if (!matches(keys, expected)) throw new Error('Unlock this device with the web app key from Crate in Obsidian.');
		const local = await unlockLocalState(keys);
		if (!current()) { local.destroy(); throw new Error('Session changed before unlocking'); }
		unlockPrivateStorage(local, localFolder, localStorage, sessionStorage);
		publish({ status: 'ready', folderPath: keys.folderPath });
		return { ...keys, localFolderPath: localFolder };
	})().catch(error => {
		if (current()) { requirePrivateStorageUnlock(); publish({ status: 'locked', message: error instanceof Error ? error.message : String(error), converting: !!state && state.mode !== 'active' }); }
		throw error;
	});
	pending = { token, promise: work };
	void work.then(value => { if (!value && pending?.promise === work) pending = undefined; }, () => { if (pending?.promise === work) pending = undefined; });
	return work;
}

export async function unlockWithWebAppKey(code: string): Promise<void> {
	const current = capturePwaSession();
	const token = localStorage.getItem(AUTH_TOKEN_KEY);
	if (!token || !state) throw new Error('Open a fresh enrollment link from Crate first');
	const { rememberWebAppKey } = await import('./web-app-unlock');
	await rememberWebAppKey(code, state, loadStoredConfig().folderPath, current);
	if (!current()) throw new Error('Session changed before unlocking');
	// Reload into the same durable outbox and drafts after keys are committed.
	window.location.reload();
}
