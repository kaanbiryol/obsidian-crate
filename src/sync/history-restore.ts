import type { Vault } from 'obsidian';
import { findHistorySource } from './history-source';
import type { FileEntry } from '../protocol/sync-types';
import { MAX_FILE_SIZE_BYTES } from '../protocol/sync-limits';
import { assertPortablePaths } from '../protocol/portable-path';
import type { SyncApiClient } from './api';
import { getAllVaultFiles } from './file-discovery';
import { assertLocalSyncPath } from './local-path-safety';
import { readLocalFileEntry } from './local-file-entry';
import { computeHash } from './hasher';
import { deletePathLocallyIfUnchanged } from './planner-helpers';
import { applyRemoteContentIfUnchanged, TEXT_PATH } from './local-apply';
import { loadHistoryRestorePreview, type HistoryRestorePreview } from './history-restore-preview';

type Files = Record<string, FileEntry>;
interface HistoryRestoreItem { path: string; action: 'revert' | 'restore' | 'remove' }
export interface HistoryRestoreReview {
    items: HistoryRestoreItem[];
    unchangedCount: number;
    preview(path: string): Promise<HistoryRestorePreview>;
    restore(): Promise<void>;
}
interface Context {
    vault: Vault;
    api: Pick<SyncApiClient, 'getManifest' | 'listFileVersions' | 'previewFileVersion' | 'downloadFile'>;
    baseline: Files;
    target: Files;
    recoveryRoot: string;
    readTarget?(path: string, file: FileEntry): Promise<ArrayBuffer>;
    shouldIgnore(path: string): boolean;
    verify(): void;
    beforeApply(): Promise<void>;
    applied(path: string, removed: boolean): void;
}

/** Compare complete inventories, not the truncated path lists displayed in activity. */
export async function createHistoryRestore(context: Context): Promise<HistoryRestoreReview & { verifySynced(): Promise<void> }> {
    const { vault, api } = context;
    const filter = (files: Files): Files => Object.assign(Object.create(null) as Files,
        Object.fromEntries(Object.entries(files).filter(([path]) => !context.shouldIgnore(path)).map(([path, entry]) => [path, { ...entry }])));
    const target = filter(context.target);
    assertPortablePaths(Object.keys(target));
    for (const path of Object.keys(target)) assertLocalSyncPath(path);
    context.verify();
    const remote = filter((await api.getManifest()).files);
    if (!sameFiles(remote, filter(context.baseline), true)) throw new Error('Run Sync now before returning to this state so all current server changes are included.');
    const local = await scanLocal(context);
    const paths = [...new Set([...Object.keys(target), ...Object.keys(local), ...Object.keys(remote)])].sort();
    const items: HistoryRestoreItem[] = paths.filter(path => local[path]?.hash !== target[path]?.hash || remote[path]?.hash !== target[path]?.hash).map(path => ({
        path, action: !target[path] ? 'remove' : local[path] ? 'revert' : 'restore',
    }));
    // Resolve the exact bytes while previewing. Expired history disables the whole
    // restore; it must never silently skip a file and report a complete rollback.
    const sources = new Map<string, () => Promise<ArrayBuffer>>();
    for (const item of items) {
        const wanted = target[item.path];
        if (!wanted) continue;
        if (wanted.size > MAX_FILE_SIZE_BYTES) throw new Error(`${item.path}: file is too large to restore.`);
        sources.set(item.path, local[item.path]?.hash === wanted.hash
            ? () => vault.adapter.readBinary(item.path)
            : context.readTarget ? () => context.readTarget!(item.path, wanted) : await findHistorySource(api, item.path, wanted, remote[item.path]));
    }
    context.verify();
    let used = false;
    const verify = async () => {
        context.verify();
        if (!sameFiles(remote, filter((await api.getManifest()).files), true)
            || !sameFiles(local, await scanLocal(context))) throw new Error('Files changed after this preview. Review the restore again.');
        context.verify();
    };
    return {
        items, unchangedCount: paths.length - items.length,
        preview: async path => {
            context.verify();
            if (used) throw new Error('Reopen the restore point to review its files.');
            if (!items.some(item => item.path === path)) throw new Error('This file is not part of the restore review.');
            const preview = await loadHistoryRestorePreview(path, local[path], target[path],
                () => vault.adapter.readBinary(path), () => sources.get(path)!());
            context.verify();
            return preview;
        },
        verifySynced: async () => {
            context.verify();
            if (!sameFiles(target, filter((await api.getManifest()).files)) || !sameFiles(target, await scanLocal(context))) {
                throw new Error('Files changed during the final sync. Automatic sync is off; review the remaining changes before continuing.');
            }
            context.verify();
        },
        restore: async () => {
            if (used) throw new Error('Review the restore again before retrying.');
            used = true;
            await verify();
            if (!items.length) return;
            const folder = `${context.recoveryRoot}/${crypto.randomUUID()}`;
            if (!await vault.adapter.exists(context.recoveryRoot)) await vault.adapter.mkdir(context.recoveryRoot);
            await vault.adapter.mkdir(folder);
            const staged = new Map<string, { original?: string; target?: string }>();
            // Stage and verify every required byte before altering any vault file.
            // Originals and the inventory remain on disk across interruption/restart.
            for (const [index, item] of items.entries()) {
                context.verify();
                const entry: { original?: string; target?: string } = {};
                const current = local[item.path];
                if (current) {
                    entry.original = `${folder}/${index}.original`;
                    await stage(vault, entry.original, await vault.adapter.readBinary(item.path), current.hash);
                }
                const wanted = target[item.path];
                if (wanted) {
                    entry.target = `${folder}/${index}.target`;
                    await stage(vault, entry.target, await sources.get(item.path)!(), wanted.hash);
                }
                staged.set(item.path, entry);
            }
            const inventory = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), items: items.map(item => ({ ...item, ...staged.get(item.path), before: local[item.path], after: target[item.path] })) });
            await vault.adapter.write(`${folder}/recovery.json`, inventory);
            if (await vault.adapter.read(`${folder}/recovery.json`) !== inventory) throw new Error('Could not verify the recovery inventory. No files were changed.');
            await verify();
            await context.beforeApply();
            try {
                // Remove later additions first, including files that now obstruct
                // a historical folder. Only empty folders may be removed on create.
                for (const item of [...items].sort((a, b) => Number(b.action === 'remove') - Number(a.action === 'remove'))) {
                    context.verify();
                    const originalHash = local[item.path]?.hash ?? null;
                    if ((await readLocalFileEntry(vault, item.path))?.hash !== local[item.path]?.hash) throw new Error(`${item.path} changed. Its new contents were kept.`);
                    if (item.action === 'remove') {
                        const outcome = await deletePathLocallyIfUnchanged({ vault }, item.path, originalHash);
                        if (outcome.status === 'changed') throw new Error(`${item.path} changed. Its new contents were kept.`);
                    } else {
                        const content = await vault.adapter.readBinary(staged.get(item.path)!.target!);
                        if (await computeHash(content) !== target[item.path]!.hash) throw new Error('The staged restore copy is damaged.');
                        const original = staged.get(item.path)!.original;
                        const text = TEXT_PATH.test(item.path) && isUtf8(content) && (!original || isUtf8(await vault.adapter.readBinary(original)));
                        let expected = originalHash;
                        if (originalHash !== null && !text) {
                            const outcome = await deletePathLocallyIfUnchanged({ vault }, item.path, originalHash);
                            if (outcome.status !== 'deleted') throw new Error(`${item.path} changed. Review the restore again.`);
                            expected = null;
                        }
                        context.verify();
                        const outcome = await applyRemoteContentIfUnchanged({ vault }, item.path, content, expected);
                        if (outcome.status !== 'applied') throw new Error(outcome.status === 'deferred' ? outcome.reason : `${item.path} could not be restored.`);
                    }
                    context.applied(item.path, item.action === 'remove');
                }
                if (!sameFiles(target, await scanLocal(context))) throw new Error('The vault changed during restore. Review the remaining changes.');
            } catch (error) {
                throw new Error(`${error instanceof Error ? error.message : 'Restore interrupted.'} Some files may already be restored. Automatic sync is off; review this checkpoint again to finish. Recovery copies: ${folder}`);
            }
        },
    };
}

async function scanLocal(context: Context): Promise<Files> {
    const files: Files = Object.create(null) as Files;
    for (const file of await getAllVaultFiles(context.vault, path => context.shouldIgnore(path))) {
        context.verify();
        const entry = await readLocalFileEntry(context.vault, file.path);
        if (!entry) throw new Error(`${file.path} changed while checking the vault. Review again.`);
        files[file.path] = entry;
    }
    return files;
}

function sameFiles(left: Files, right: Files, revisions = false): boolean {
    return Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([path, file]) =>
        file.hash === right[path]?.hash && (!revisions || file.revision === right[path]?.revision));
}


async function stage(vault: Vault, path: string, bytes: ArrayBuffer, hash: string): Promise<void> {
    if (bytes.byteLength > MAX_FILE_SIZE_BYTES || await computeHash(bytes) !== hash) throw new Error('A file changed or its saved version is damaged. No files were changed.');
    await vault.adapter.writeBinary(path, bytes);
    if (await computeHash(await vault.adapter.readBinary(path)) !== hash) throw new Error('Could not verify a recovery copy. No files were changed.');
}

function isUtf8(bytes: ArrayBuffer): boolean {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; }
    catch { return false; }
}
