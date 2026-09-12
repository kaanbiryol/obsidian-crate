import { FileSystemAdapter, Platform, TFile, type App } from 'obsidian';
import type { ConflictRecord } from './types';

export type ConflictChoice = 'current' | 'saved' | 'both' | 'manual';
export interface ConflictReview {
    currentText?: string;
    savedText?: string;
    currentSize: number;
    savedSize: number;
    openVersion(version: 'current' | 'saved'): Promise<void>;
    resolve(choice: ConflictChoice, editedText?: string): Promise<string>;
}

const equal = (a: ArrayBuffer, b: ArrayBuffer) => {
    if (a.byteLength !== b.byteLength) return false;
    const left = new Uint8Array(a), right = new Uint8Array(b);
    return left.every((byte, index) => byte === right[index]);
};

export async function createConflictReview(
    app: App, backupRoot: string, record: ConflictRecord,
    isSyncing: () => boolean, onResolved: () => Promise<void>,
): Promise<ConflictReview> {
    const file = (path: string) => {
        const found = app.vault.getAbstractFileByPath(path);
        if (!(found instanceof TFile)) throw new Error(`File unavailable: ${path}. Reopen the conflict after checking the vault.`);
        return found;
    };
    const original = file(record.originalPath), saved = file(record.conflictPath);
    const currentBytes = await app.vault.readBinary(original);
    const savedBytes = await app.vault.readBinary(saved);
    const markdown = original.extension.toLowerCase() === 'md' && Math.max(currentBytes.byteLength, savedBytes.byteLength) <= 1_000_000;
    let busy = false;
    let completed = false;
    const verify = async () => {
        if (isSyncing()) throw new Error('Wait for sync to finish before resolving this conflict.');
        if (original.path !== record.originalPath || saved.path !== record.conflictPath
            || !equal(await app.vault.readBinary(file(record.originalPath)), currentBytes)
            || !equal(await app.vault.readBinary(file(record.conflictPath)), savedBytes)) {
            throw new Error('A file changed while you were reviewing it. Close and reopen this review.');
        }
    };
    return {
        currentSize: currentBytes.byteLength, savedSize: savedBytes.byteLength,
        ...(markdown ? { currentText: new TextDecoder().decode(currentBytes), savedText: new TextDecoder().decode(savedBytes) } : {}),
        openVersion: async version => {
            const target = file(version === 'current' ? record.originalPath : record.conflictPath);
            if (Platform.isDesktopApp && app.vault.adapter instanceof FileSystemAdapter) {
                // Electron is only available in the desktop host; never loaded on mobile.
                // eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron must load only in the desktop host.
                const { shell } = require('electron') as { shell: { openPath(path: string): Promise<string> } };
                const error = await shell.openPath(app.vault.adapter.getFullPath(target.path));
                if (error) throw new Error(error);
            } else {
                await app.workspace.getLeaf('tab').openFile(target);
            }
        },
        resolve: async (choice, editedText) => {
            if (busy || completed) throw new Error('This review is already being resolved.');
            busy = true;
            try {
                await verify();
                const folder = `${backupRoot}/conflict-recovery/${crypto.randomUUID()}`;
                if (!await app.vault.adapter.exists(`${backupRoot}/conflict-recovery`)) await app.vault.adapter.mkdir(`${backupRoot}/conflict-recovery`);
                await app.vault.adapter.mkdir(folder);
                await app.vault.adapter.writeBinary(`${folder}/current`, currentBytes);
                await app.vault.adapter.writeBinary(`${folder}/saved`, savedBytes);
                await app.vault.adapter.write(`${folder}/info.json`, JSON.stringify({ ...record, choice, savedAt: new Date().toISOString() }));
                if (!equal(await app.vault.adapter.readBinary(`${folder}/current`), currentBytes)
                    || !equal(await app.vault.adapter.readBinary(`${folder}/saved`), savedBytes)) throw new Error('Could not verify recovery copies. No files were replaced.');
                await verify();
                if (choice === 'both') {
                    const dot = original.path.lastIndexOf('.');
                    const stem = dot > original.path.lastIndexOf('/') ? original.path.slice(0, dot) : original.path;
                    const ext = dot > original.path.lastIndexOf('/') ? original.path.slice(dot) : '';
                    await app.vault.createBinary(`${stem} (saved copy ${crypto.randomUUID().slice(0, 8)})${ext}`, savedBytes);
                } else if (choice === 'saved' || choice === 'manual') {
                    if (choice === 'manual' && (!markdown || editedText === undefined)) throw new Error('Edited Markdown is required.');
                    if (markdown) {
                        await app.vault.process(original, current => {
                            if (!equal(new TextEncoder().encode(current).buffer, currentBytes)) throw new Error('The current file changed. Reopen this review.');
                            return choice === 'manual' ? editedText! : new TextDecoder().decode(savedBytes);
                        });
                    } else {
                        await app.vault.modifyBinary(original, savedBytes);
                    }
                }
                // Do not discard a saved copy edited during the operation.
                if (!equal(await app.vault.readBinary(saved), savedBytes)) throw new Error('The saved copy changed and was kept. Reopen the conflict to review it.');
                await app.fileManager.trashFile(saved);
                await onResolved();
                completed = true;
                return folder;
            } finally { busy = false; }
        },
    };
}
