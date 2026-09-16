import { TFile, type App } from 'obsidian';
import { isHiddenPath } from './file-discovery';
import { assertLocalSyncPath } from './local-path-safety';

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
            if (visible.path !== path || vault.getAbstractFileByPath(path) !== visible) throw unavailable();
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
            if (visible) await vault.process(visible, update);
            else await vault.adapter.process(path, update);
        },
        writeBinary: async (bytes: ArrayBuffer) => {
            await check();
            if (visible) await vault.modifyBinary(visible, bytes);
            else await vault.adapter.writeBinary(path, bytes);
        },
        trash: async () => {
            await check();
            if (visible) await app.fileManager.trashFile(visible);
            else await vault.adapter.trashLocal(path);
        },
    };
}
