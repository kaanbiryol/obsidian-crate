import { EncryptionKeyRequiredError, rememberEncryptionUnlock } from './encryption-onboarding';
import { loadEncryptionState, loadScopeKeys, assertEncryptionActive } from './connection/encryption';
import type { ScopedEncryptionState } from './encryption-scope';
import type { StoredReminderKeys } from './encryption-keys';
import { requirePrivateStorageUnlock, unlockPrivateStorage, lockPrivateStorage, useUnencryptedStorage } from './private-storage';
import { capturePwaSession } from './session-generation';
import { AUTH_TOKEN_KEY, loadStoredConfig } from './config';
import type { ApiFetch } from './types';

type ScopeState = ScopedEncryptionState;
type EncryptionView = { status: 'checking' | 'legacy' } | { status: 'ready'; folderPath: string }
	| { status: 'locked'; message: string; converting: boolean; setupRequired: boolean };
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
		const expected = await loadEncryptionState({ token, purpose: 'reminders', fragment: fragmentCode, request: () => rawFetch('/encryption'), current });
		if (!expected) {
			useUnencryptedStorage();
			state = undefined;
			publish({ status: 'legacy' });
			return null;
		}
		state = expected;
		if (view.status !== 'ready') requirePrivateStorageUnlock();
		assertEncryptionActive(expected);
		const localFolder = loadStoredConfig().folderPath;
		const { unlockLocalState } = await import('./encryption-keys');
		const keys = await loadScopeKeys(expected, localFolder, current, fragmentCode);
		fragmentCode = undefined;
		const local = await unlockLocalState(keys);
		if (!current()) { local.destroy(); throw new Error('Session changed before unlocking'); }
		unlockPrivateStorage(local, localFolder, localStorage, sessionStorage);
		rememberEncryptionUnlock(expected.vaultId);
		publish({ status: 'ready', folderPath: keys.folderPath });
		return { ...keys, localFolderPath: localFolder };
	})().catch(error => {
		if (current()) { requirePrivateStorageUnlock(); publish({ status: 'locked', message: error instanceof Error ? error.message : String(error), converting: !!state && state.mode !== 'active', setupRequired: error instanceof EncryptionKeyRequiredError && error.firstUnlock }); }
		throw error;
	});
	pending = { token, promise: work };
	void work.then(value => { if (!value && pending?.promise === work) pending = undefined; }, () => { if (pending?.promise === work) pending = undefined; });
	return work;
}

export async function unlockWithRecoveryKey(code: string): Promise<void> {
	const sessionCurrent = capturePwaSession();
	const token = localStorage.getItem(AUTH_TOKEN_KEY);
	if (!token || !state) throw new Error('Open a fresh enrollment link from Crate first');
	const expected = state;
	const current = () => sessionCurrent() && state === expected;
	const { rememberRecoveryKey } = await import('./web-app-unlock');
	await rememberRecoveryKey(code, expected, loadStoredConfig().folderPath, current);
	if (!current()) throw new Error('Session changed before unlocking');
	// Reload into the same durable outbox and drafts after keys are committed.
	window.location.reload();
}
