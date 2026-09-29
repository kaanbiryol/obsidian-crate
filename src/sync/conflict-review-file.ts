import { TFile, type App } from 'obsidian';
import { isHiddenPath } from './file-discovery';
import { assertLocalSyncPath } from './local-path-safety';
import { isCurrentVaultFile } from '../platform/vault-file-identity';
import { replaceLocalFileWithRecovery } from './local-recovery-write';
import { deletePathLocallyIfUnchanged } from './planner-helpers';
import { computeHash } from './hasher';

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
            await replaceLocalFileWithRecovery(vault, path, bytes, await computeHash(expected), assertCurrent);
        },
        trash: async (expected: ArrayBuffer) => {
            await check();
            const outcome = await deletePathLocallyIfUnchanged({ vault }, path, await computeHash(expected));
            if (outcome.status !== 'deleted') throw unavailable();
        },
    };
}
