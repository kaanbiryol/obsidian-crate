import { TFile, type App } from 'obsidian';
import { isHiddenPath } from '../local/file-discovery';
import { assertLocalSyncPath } from '../local/local-path-safety';
import { isCurrentVaultFile } from '../local/vault-file-identity';
import { replaceLocalFileWithRecovery } from '../local/local-recovery-write';
import { deletePathLocallyIfUnchanged } from '../local/local-delete';
import { sha256Hex } from '../../platform/sha256';

/** Hidden configuration files are not represented by Obsidian TFiles. */
export async function conflictReviewFile(app: App, path: string) {
	assertLocalSyncPath(path);
	const { vault } = app;
	const hidden = isHiddenPath(path);
	const indexed = vault.getAbstractFileByPath(path);
	const unavailable = () => new Error(`File unavailable: ${path}. Check that it still exists, then reload the versions.`);
	if (!hidden && !(indexed instanceof TFile)) throw unavailable();
	const visible = indexed instanceof TFile && !hidden ? indexed : undefined;
	const check = async () => {
		if (visible) {
			if (!isCurrentVaultFile(vault, path, visible)) throw unavailable();
		} else if ((await vault.adapter.stat(path))?.type !== 'file') throw unavailable();
	};
	await check();
	return {
		path,
		visible,
		read: async () => {
			await check();
			return visible ? vault.readBinary(visible) : vault.adapter.readBinary(path);
		},
		process: async (update: (current: string) => string) => {
			await check();
			if (visible) await vault.process(visible, current => {
				if (!isCurrentVaultFile(vault, path, visible)) throw unavailable();
				return update(current);
			});
			else await vault.adapter.process(path, update);
		},
		writeBinary: async (bytes: ArrayBuffer, expected: ArrayBuffer, assertCurrent: () => void) => {
			await check();
			await replaceLocalFileWithRecovery(vault, path, bytes, await sha256Hex(expected), assertCurrent);
		},
		trash: async (expected: ArrayBuffer) => {
			await check();
			const outcome = await deletePathLocallyIfUnchanged({ vault }, path, await sha256Hex(expected));
			if (outcome.status !== 'deleted') throw unavailable();
		},
	};
}
