import type { Vault } from 'obsidian';
import type { FileEntry } from '../protocol/sync-types';
import { MAX_FILE_SIZE_BYTES } from '../protocol/sync-limits';
import { computeHash } from './hasher';
import { assertLocalSyncPath } from './local-path-safety';
import { isHiddenPath } from './file-discovery';
import { deletePathLocallyIfUnchanged } from './planner-helpers';
import { applyRemoteContentIfUnchanged, TEXT_PATH } from './local-apply';

interface DiscardItem {
    path: string;
    action: 'restore' | 'trash';
}
export interface PendingDiscardReview {
    items: DiscardItem[];
    unchangedCount: number;
    discard(): Promise<void>;
}
interface DiscardContext {
    vault: Vault;
    getBaseline(path: string): FileEntry | undefined;
    readBase(path: string, hash: string): Promise<ArrayBuffer | null>;
    backupRoot: string;
    verify(): void;
    beforeBinaryReplace(path: string): Promise<void>;
    applied(path: string, remote: FileEntry | undefined, content?: ArrayBuffer): Promise<void>;
}
interface DiscardSnapshot extends DiscardItem { localHash: string | null; remote?: FileEntry }

/** Capture confirmation versions without holding file contents in memory. */
export async function createPendingDiscard(context: DiscardContext, keys: string[]): Promise<PendingDiscardReview> {
    const paths = [...new Set(keys.map(key => key.startsWith('delete:') ? key.slice(7) : key))];
    for (const path of paths) assertLocalSyncPath(path);
    context.verify();
    const snapshots: DiscardSnapshot[] = [];
    for (const path of paths) {
        const localHash = await readHash(context.vault, path);
        const remote = context.getBaseline(path);
        if (localHash === (remote?.hash ?? null)) continue;
        if ((remote?.size ?? 0) > MAX_FILE_SIZE_BYTES) throw new Error(`${path}: file is too large to restore.`);
        if (remote) await readBaseline(context, path, remote);
        snapshots.push({ path, localHash, remote: remote ? { ...remote } : undefined, action: remote ? 'restore' : 'trash' });
    }
    context.verify();
    let used = false;
    return {
        items: snapshots.map(({ path, action }) => ({ path, action })),
        unchangedCount: paths.length - snapshots.length,
        discard: async () => {
            if (used) throw new Error('Reopen discard to review the current files.');
            used = true;
            // Validate the entire selection before the first destructive operation.
            await verifySnapshots(context, snapshots);
            for (const snapshot of snapshots) {
                await discardOne(context, snapshot);
            }
        },
    };
}

async function readHash(vault: Vault, path: string): Promise<string | null> {
    const stat = await vault.adapter.stat(path);
    if (!stat) return null;
    if (stat.type !== 'file') throw new Error(`${path}: a folder now occupies this path.`);
    if (stat.size > MAX_FILE_SIZE_BYTES) throw new Error(`${path}: file is too large to discard safely.`);
    const bytes = await vault.adapter.readBinary(path);
    if (bytes.byteLength > MAX_FILE_SIZE_BYTES) throw new Error(`${path}: file is too large to discard safely.`);
    return computeHash(bytes);
}

async function verifySnapshots(context: DiscardContext, snapshots: DiscardSnapshot[]): Promise<void> {
    context.verify();
    if (!snapshots.length) return;
    for (const item of snapshots) {
        const remote = context.getBaseline(item.path);
        if ((remote?.hash ?? null) !== (item.remote?.hash ?? null) || remote?.revision !== item.remote?.revision
            || await readHash(context.vault, item.path) !== item.localHash) {
            throw new Error(`${item.path} changed. Reopen discard to review the latest version.`);
        }
    }
    context.verify();
}

async function discardOne(context: DiscardContext, item: DiscardSnapshot): Promise<void> {
    const { vault } = context;
    let content: ArrayBuffer | undefined;
    if (item.remote) {
        content = await readBaseline(context, item.path, item.remote);
    }
    // Keep recoverable local bytes even if an interrupted restore needs retrying.
    let original: ArrayBuffer | undefined;
    if (item.localHash !== null) {
        original = await vault.adapter.readBinary(item.path);
        if (await computeHash(original) !== item.localHash) throw new Error(`${item.path} changed. Reopen discard.`);
        const folder = `${context.backupRoot}/${crypto.randomUUID()}`;
        if (!await vault.adapter.exists(context.backupRoot)) await vault.adapter.mkdir(context.backupRoot);
        await vault.adapter.mkdir(folder);
        await vault.adapter.writeBinary(`${folder}/original`, original);
        await vault.adapter.write(`${folder}/info.json`, JSON.stringify({ path: item.path, hash: item.localHash, action: item.action, savedAt: new Date().toISOString() }));
        if (await computeHash(await vault.adapter.readBinary(`${folder}/original`)) !== item.localHash) throw new Error('Could not verify the recovery copy. The file was kept.');
    }
    await verifySnapshots(context, [item]);
    if (!content) {
        const outcome = await deletePathLocallyIfUnchanged({ vault }, item.path, item.localHash);
        if (outcome.status === 'changed') throw new Error(`${item.path} changed. Its contents were kept.`);
    } else {
        const atomicText = original && TEXT_PATH.test(item.path) && isUtf8(original) && isUtf8(content);
        if (atomicText || !isHiddenPath(item.path) && item.localHash === null) {
            const outcome = await applyRemoteContentIfUnchanged({ vault }, item.path, content, item.localHash);
            if (outcome.status === 'deferred') throw new Error(outcome.reason);
        } else {
            // Binary replacements move the current bytes to trash first. A failed
            // create leaves both the trash entry and verified recovery copy intact.
            if (item.localHash !== null) {
                await context.beforeBinaryReplace(item.path);
                context.verify();
                const outcome = await deletePathLocallyIfUnchanged({ vault }, item.path, item.localHash);
                if (outcome.status !== 'deleted') throw new Error(`${item.path} changed. Reopen discard.`);
            }
            const parent = item.path.includes('/') ? item.path.slice(0, item.path.lastIndexOf('/')) : '';
            if (parent && !await vault.adapter.exists(parent)) {
                if (isHiddenPath(item.path)) await vault.adapter.mkdir(parent);
                else await vault.createFolder(parent);
            }
            context.verify();
            if (await vault.adapter.stat(item.path)) throw new Error(`${item.path} was recreated. Its contents were kept.`);
            if (isHiddenPath(item.path)) await vault.adapter.writeBinary(item.path, content);
            else await vault.createBinary(item.path, content);
        }
    }
    context.verify();
    await context.applied(item.path, item.remote, content);
}

function isUtf8(bytes: ArrayBuffer): boolean {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; }
    catch { return false; }
}

async function readBaseline(context: DiscardContext, path: string, baseline: FileEntry): Promise<ArrayBuffer> {
    const content = await context.readBase(path, baseline.hash);
    if (!content || content.byteLength > MAX_FILE_SIZE_BYTES || await computeHash(content) !== baseline.hash) {
        throw new Error(`${path}: the last-synced copy is not available on this device. Local changes were kept.`);
    }
    return content;
}
