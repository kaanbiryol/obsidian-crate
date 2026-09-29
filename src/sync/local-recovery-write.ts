import type { Vault } from 'obsidian';
import { assertLocalSyncPath } from './local-path-safety';
import { deletePathLocallyIfUnchanged } from './planner-helpers';

/** Explicit recovery only: preserve the bytes actually displaced, then create.
 * Never use an overwriting adapter write, even for hidden files. The host's
 * create must reject a recreation; an interrupted replacement remains in trash.
 */
export async function replaceLocalFileWithRecovery(
	vault: Vault, path: string, content: ArrayBuffer, expectedHash: string | null,
	assertCurrent: () => void = () => {},
): Promise<void> {
	assertLocalSyncPath(path);
	assertCurrent();
	if (expectedHash !== null) {
		const outcome = await deletePathLocallyIfUnchanged({ vault }, path, expectedHash);
		if (outcome.status !== 'deleted') throw new Error(`${path} changed. Reopen the recovery review. Its contents were kept.`);
	}
	try {
		assertCurrent();
		await vault.createBinary(path, content);
	}
	catch (error) {
		if (expectedHash === null) throw error;
		throw new Error(`${path}: replacement could not finish. The previous file is in local trash; recovery copies were kept. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}
