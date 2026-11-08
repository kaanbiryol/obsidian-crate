import type { Vault } from 'obsidian';
import type { SyncSettings } from '../settings';
import type { SyncWork } from '../types';

const TRASH_FOLDER = '.trash';

/** Moves everything in the vault to Obsidian's local trash so the first sync with
 * a joined server adopts its contents. Hidden files, settings and ignored paths
 * move too; only the trash itself and Crate's own plugin folder stay. Each entry
 * moves whole, so a rerun after an interruption continues with what is left. */
export async function moveVaultToTrash(vault: Vault, pluginDir: string, throwIfDestroyed: () => void): Promise<void> {
	const kept = [TRASH_FOLDER, pluginDir];
	const moveChildren = async (folder: string): Promise<void> => {
		throwIfDestroyed();
		const { files, folders } = await vault.adapter.list(folder);
		for (const path of [...folders, ...files]) {
			if (kept.includes(path)) continue;
			if (kept.some(keep => keep.startsWith(`${path}/`))) {
				await moveChildren(path);
				continue;
			}
			throwIfDestroyed();
			const entry = vault.getAbstractFileByPath(path);
			// Like sync deletes, never honor a permanent-delete preference: the old contents must stay recoverable.
			if (entry) await vault.trash(entry, false);
			else await vault.adapter.trashLocal(path);
		}
	};
	await moveChildren('');
}

/** Carries out a confirmed vault replacement before the first sync with a joined server,
 * then clears the confirmation; the caller saves the cleared flag. Once a file has
 * synced, moving the vault again would trash the server's copies, so a vault with a
 * file baseline or a changelog cursor keeps its files. */
export async function replaceVaultBeforeFirstSync({ settings, manifest, vault, pluginDir, reportWork, throwIfDestroyed }: {
	settings: Pick<SyncSettings, 'replaceVault' | 'lastSeq'>;
	manifest: { getManifest(): { readonly files: Readonly<Record<string, unknown>> } };
	vault: Vault;
	pluginDir: string;
	reportWork: (work: SyncWork) => void;
	throwIfDestroyed: () => void;
}): Promise<void> {
	if (!settings.replaceVault) return;
	if (settings.lastSeq === 0 && !Object.keys(manifest.getManifest().files).length) {
		reportWork({ phase: 'applying' });
		await moveVaultToTrash(vault, pluginDir, throwIfDestroyed);
	}
	settings.replaceVault = false;
}
