import type { SecretStorageService } from '../plugin/secret-storage';
import { SECRET_KEYS, type CrateSettings } from '../plugin/settings-types';
import { prepareEncryptedAddressChange } from './encrypted-connection';
import { loadEncryptionReset, saveEncryptionReset, verifyEncryptionResetAddress } from './encryption-reset';
import type { RuntimeConfigurationTransition } from './runtime';
import { resetStoredSyncState } from './runtime-history';
import { getCheckpointAuthority, requireNormalizedWorkerUrl } from './worker-url';
import { WorkerApiHttpClient } from './worker-api/http';

interface AddressWorkflowContext {
	settings: CrateSettings;
	secretStorage: SecretStorageService;
	transition: RuntimeConfigurationTransition;
	persistSettings: (update?: Partial<CrateSettings>) => Promise<void>;
	clearLocalState: () => Promise<void>;
	emitCurrentState: () => void;
}

export async function changeEncryptedServerAddress(
	{ settings, secretStorage, transition, persistSettings }: AddressWorkflowContext,
	address: string, signal: AbortSignal, expected: { workerUrl: string; authToken: string },
): Promise<void> {
	const workerUrl = requireNormalizedWorkerUrl(address);
	const verify = () => {
		transition.verify();
		if (settings.cloudflareDeployment || settings.workerUrl !== expected.workerUrl || secretStorage.get(SECRET_KEYS.AUTH_TOKEN) !== expected.authToken) {
			throw new Error('The server connection changed. Reopen settings and try again.');
		}
	};
	verify();
	const http = new WorkerApiHttpClient(workerUrl, expected.authToken);
	http.setAbortSignal(signal);
	const copy = await prepareEncryptedAddressChange(secretStorage, http, workerUrl);
	verify();
	if (workerUrl === expected.workerUrl) return;
	transition.stop();
	await transition.waitForIdle();
	verify();
	copy();
	const previous = settings.checkpointScope;
	settings.checkpointScope = { workerUrl, authority: getCheckpointAuthority(settings) };
	settings.workerUrl = workerUrl;
	try { await persistSettings(); }
	catch (error) { settings.workerUrl = expected.workerUrl; settings.checkpointScope = previous; throw error; }
	transition.verify();
	await transition.initialize();
}

export async function changeEncryptionResetAddress(
	{ settings, secretStorage, transition, persistSettings, clearLocalState, emitCurrentState }: AddressWorkflowContext,
	address: string, signal?: AbortSignal,
): Promise<void> {
	if (settings.cloudflareDeployment) throw new Error('Only self-hosted server addresses can be changed');
	const reset = loadEncryptionReset(secretStorage);
	if (!reset || reset.workerUrl !== settings.workerUrl) throw new Error('The pending reset connection changed. Reopen settings.');
	const workerUrl = requireNormalizedWorkerUrl(address);
	const { verify } = transition;
	verify();
	await verifyEncryptionResetAddress(reset, token => {
		const http = new WorkerApiHttpClient(workerUrl, token);
		if (signal) http.setAbortSignal(signal);
		return http;
	});
	verify();
	if (workerUrl === reset.workerUrl) return;
	transition.stop();
	await transition.waitForIdle();
	verify();
	const target = secretStorage.forScope(workerUrl);
	const existing = loadEncryptionReset(target);
	if (existing && existing.id !== reset.id) throw new Error('The new address has a different unfinished reset');
	for (const key of [SECRET_KEYS.AUTH_TOKEN, SECRET_KEYS.ENCRYPTION_KEYS, SECRET_KEYS.ENCRYPTION_RECOVERY]) {
		const value = secretStorage.get(key);
		if (value) target.set(key, value); else target.delete(key);
		if (target.get(key) !== value) throw new Error('Could not verify the moved reset credentials');
	}
	saveEncryptionReset(target, { ...reset, workerUrl });
	// These records name the old URL. Preserve recovery copies and reconcile
	// from scratch, rather than replaying old authority against the new address.
	await clearLocalState();
	verify();
	const oldUrl = settings.workerUrl;
	settings.workerUrl = workerUrl;
	resetStoredSyncState(settings);
	try { await persistSettings(); }
	catch (error) { settings.workerUrl = oldUrl; throw error; }
	verify();
	// The old scoped recovery copy is deliberately retained if saving or
	// shutdown was interrupted. Only the persisted URL is active on restart.
	emitCurrentState();
}
