import { ENCRYPTION_STATE_HEADER } from '@/encryption/server-state';

// The token and session whose latest authenticated response said the vault is not
// encrypted, and when that request was sent. Shared so the app's client trusts the
// startup probe instead of repeating it.
let encryptionOff: { token: string; current: () => boolean; at: number } | null = null;
// Bumped whenever that verdict is dropped, so a response already in flight cannot restore it.
let encryptionOffResets = 0;
/** How long that verdict lets a change skip the probe before sending plaintext. */
const ENCRYPTION_OFF_TRUST_MS = 30_000;
function forgetEncryptionOff(): void {
	encryptionOff = null;
	encryptionOffResets++;
}

/** When a request was sent, and which verdict was standing then. */
export interface EncryptionOffDispatch { at: number; resets: number }
/** Taken just before a request is sent, for `noteEncryptionReport`. */
export function encryptionOffDispatch(): EncryptionOffDispatch {
	return { at: performance.now(), resets: encryptionOffResets };
}

/** Applies one authenticated response's encryption report. `unverified` marks a read sent
 * before the startup check, which must not let that check be skipped. */
export function noteEncryptionReport(response: Response, dispatched: EncryptionOffDispatch, sender: { token: string; current: () => boolean; unverified: boolean }): void {
	const encryptionState = response.headers.get(ENCRYPTION_STATE_HEADER);
	// A refusal may mean another device turned encryption on and revoked or locked this credential.
	if (encryptionState === 'on' || [401, 403, 423, 428].includes(response.status)) forgetEncryptionOff();
	else if (encryptionState === 'off' && !sender.unverified && dispatched.resets === encryptionOffResets) encryptionOff = { token: sender.token, current: sender.current, at: dispatched.at };
}

/** Whether a recent unencrypted verdict for `token` lets a request skip the probe.
 * `beforeChange` trusts only a recent verdict before a request sends plaintext. */
export function trustsEncryptionOff(token: string, beforeChange: boolean): boolean {
	return encryptionOff?.token === token && encryptionOff.current()
		&& (!beforeChange || performance.now() - encryptionOff.at < ENCRYPTION_OFF_TRUST_MS);
}
