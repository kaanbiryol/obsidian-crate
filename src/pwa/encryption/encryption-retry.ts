import { requestSharedFeaturesRefresh } from '../shared-features';

/** The server's encryption state changed under a request; retry once after refreshing it. */
export class EncryptionStateChangedError extends Error {}

/** Runs a request, then once more with refreshed keys if the vault's encryption changed under it. */
export async function retryAfterEncryptionChange<T>(run: (refresh: boolean) => Promise<T>): Promise<T> {
	try { return await run(false); }
	catch (error) {
		if (!(error instanceof EncryptionStateChangedError)) throw error;
		return run(true);
	}
}

/** Encryption signals every feature client handles: a 428 outside the feature's own
 * encryption probe means the vault's encryption changed, and a 423 pauses features
 * until they are read again. */
export function checkEncryptionSignals(response: Response, path: string,
	{ probePath, message, encrypted = true }: { probePath: string; message: string; encrypted?: boolean }): void {
	if (encrypted && response.status === 428 && path !== probePath) throw new EncryptionStateChangedError(message);
	if (response.status === 423) requestSharedFeaturesRefresh(true);
}
