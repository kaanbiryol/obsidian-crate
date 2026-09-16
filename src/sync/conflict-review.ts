import { FileSystemAdapter, Platform, type App } from 'obsidian';
import type { ConflictRecord } from './types';
import { conflictReviewFile } from './conflict-review-file';
import { TEXT_PATH } from './local-apply';

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
    const original = await conflictReviewFile(app, record.originalPath);
    const saved = await conflictReviewFile(app, record.conflictPath);
    const currentBytes = await original.read();
    const savedBytes = await saved.read();
    let currentText: string | undefined, savedText: string | undefined;
    if (TEXT_PATH.test(original.path) && Math.max(currentBytes.byteLength, savedBytes.byteLength) <= 1_000_000) {
        try {
            const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
            const current = decoder.decode(currentBytes), other = decoder.decode(savedBytes);
            // Avoid presenting binary content as editable text.
            const binary = /[\x00-\x08\x0b\x0c\x0e-\x1f]/; // eslint-disable-line no-control-regex -- Detect binary control characters.
            if (!binary.test(current) && !binary.test(other)) { currentText = current; savedText = other; }
        } catch { /* Binary files can still be opened and resolved without a text preview. */ }
    }
    const text = currentText !== undefined && savedText !== undefined;
    let busy = false;
    let completed = false;
    const verify = async () => {
        if (isSyncing()) throw new Error('Wait for sync to finish before resolving this conflict.');
        if (!equal(await original.read(), currentBytes) || !equal(await saved.read(), savedBytes)) {
            throw new Error('A file changed while you were reviewing it. Close and reopen this review.');
        }
    };
    return {
        currentSize: currentBytes.byteLength, savedSize: savedBytes.byteLength,
        ...(text ? { currentText, savedText } : {}),
        openVersion: async version => {
            const target = version === 'current' ? original : saved;
            if (Platform.isDesktopApp && app.vault.adapter instanceof FileSystemAdapter) {
                // Electron is provided by Obsidian's desktop host and excluded in
                // Vite/Knip; it is not an npm dependency and is never loaded on mobile.
                // eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron must load only in the desktop host.
                const { shell } = require('electron') as { shell: { openPath(path: string): Promise<string> } };
                const error = await shell.openPath(app.vault.adapter.getFullPath(target.path));
                if (error) throw new Error(error);
            } else {
                if (!target.visible) throw new Error('This configuration file cannot be opened in Obsidian. Use the comparison below.');
                await app.workspace.getLeaf('tab').openFile(target.visible);
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
                    if (choice === 'manual' && (!text || editedText === undefined)) throw new Error('Edited text is required.');
                    if (text) {
                        await original.process(current => {
                            if (!equal(new TextEncoder().encode(current).buffer, currentBytes)) throw new Error('The current file changed. Reopen this review.');
                            return choice === 'manual' ? editedText! : savedText!;
                        });
                    } else {
                        await original.writeBinary(savedBytes);
                    }
                }
                // Do not discard a saved copy edited during the operation.
                if (!equal(await saved.read(), savedBytes)) throw new Error('The saved copy changed and was kept. Reopen the conflict to review it.');
                await saved.trash();
                await onResolved();
                completed = true;
                return folder;
            } finally { busy = false; }
        },
    };
}
