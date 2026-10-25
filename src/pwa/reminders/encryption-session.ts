import { EncryptionKeyRequiredError, rememberEncryptionUnlock } from '../encryption/encryption-onboarding';
import { loadEncryptionState, loadVaultKeys, assertEncryptionActive } from '../connection/encryption';
import type { EncryptionServerState } from '../../encryption/server-state';
import type { FeatureKeys } from '../encryption/encryption-keys';
import { requirePrivateStorageUnlock, unlockPrivateStorage, lockPrivateStorage, useUnencryptedStorage } from './private-storage';
import { capturePwaSession } from '../session-generation';
import { AUTH_TOKEN_KEY, adoptReminderFolder } from '../config';
import type { ApiFetch } from '../types';
import { takeFragmentValues } from '../encryption/encryption-fragments';
import { unlockLocalState } from '../encryption/encryption-keys';
import { rememberRecoveryKey } from '../encryption/web-app-unlock';

type EncryptionView = { status: 'checking' | 'unencrypted' } | { status: 'ready'; folderPath: string }
	| { status: 'locked'; message: string; converting: boolean; setupRequired: boolean };
let view: EncryptionView = { status: 'checking' };
const listeners = new Set<() => void>();
let pending: { token: string; promise: Promise<FeatureKeys | null> } | undefined;
let state: EncryptionServerState | undefined;
let fragmentCode: string | undefined;

export const subscribeReminderEncryption = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const reminderEncryptionSnapshot = () => view;
function publish(next: EncryptionView) { view = next; for (const listener of listeners) listener(); }

export function consumeReminderEncryptionFragment(): void {
	const { crateKey } = takeFragmentValues(['crateKey']);
	if (crateKey) fragmentCode = crateKey;
}

export function resetReminderEncryption(discardKeys = false): void {
	pending = undefined; state = undefined;
	if (discardKeys) fragmentCode = undefined;
	lockPrivateStorage();
	publish({ status: 'checking' });
}

export function prepareReminderEncryption(token: string, rawFetch: ApiFetch, refresh = false): Promise<FeatureKeys | null> {
	if (refresh) pending = undefined;
	if (pending?.token === token) return pending.promise;
	const sessionCurrent = capturePwaSession();
	const current = () => sessionCurrent() && pending?.promise === work;
	// Keep the last confirmed state during a same-session refresh. Initial
	// startup and reset already publish checking; changing it here races push
	// provider selection against an ordinary concurrent reminder-list request.
	const work = (async () => {
		const verified = await loadEncryptionState({ token, purpose: 'reminders', fragment: fragmentCode, request: () => rawFetch('/encryption'), current });
		const expected = verified?.state;
		if (!verified || !expected) {
			useUnencryptedStorage();
			state = undefined;
			publish({ status: 'unencrypted' });
			return null;
		}
		state = expected;
		if (view.status !== 'ready') requirePrivateStorageUnlock();
		assertEncryptionActive(expected);
		if (!verified.folderPath) throw new Error('Update the Crate server and reconnect this app from Obsidian.');
		const keys = await loadVaultKeys(verified, verified.folderPath, current, fragmentCode);
		fragmentCode = undefined;
		const local = await unlockLocalState(keys, 'reminders');
		if (!current()) { local.destroy(); throw new Error('Session changed before unlocking'); }
		// The session follows reminders folder changes made in Obsidian.
		adoptReminderFolder(keys.folderPath);
		unlockPrivateStorage(local, keys.folderPath, localStorage, sessionStorage);
		rememberEncryptionUnlock(expected.vaultId);
		publish({ status: 'ready', folderPath: keys.folderPath });
		return keys;
	})().catch(error => {
		if (current()) { requirePrivateStorageUnlock(); publish({ status: 'locked', message: error instanceof Error ? error.message : String(error), converting: !!state && state.mode !== 'active', setupRequired: error instanceof EncryptionKeyRequiredError && error.firstUnlock }); }
		throw error;
	});
	pending = { token, promise: work };
	void work.then(value => { if (!value && pending?.promise === work) pending = undefined; }, () => { if (pending?.promise === work) pending = undefined; });
	return work;
}

export async function unlockRemindersWithCode(code: string): Promise<void> {
	const sessionCurrent = capturePwaSession();
	const token = localStorage.getItem(AUTH_TOKEN_KEY);
	if (!token || !state) throw new Error('Open a fresh enrollment link from Crate first');
	const expected = state;
	const current = () => sessionCurrent() && state === expected;
	await rememberRecoveryKey(code, expected, current);
	if (!current()) throw new Error('Session changed before unlocking');
	// Reload into the same durable outbox and drafts after keys are committed.
	window.location.reload();
}
