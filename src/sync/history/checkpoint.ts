import type { DataAdapter } from 'obsidian';
import { isRecord, isSha256Hex } from '../../platform/validation';
import { parseSyncFiles } from '../../protocol/sync-validation';
import { assertPortablePaths } from '../../protocol/portable-path';
import type { FileEntry } from '../../protocol/sync-types';
import { sha256Hex } from '../../platform/sha256';

interface HistoryCheckpoint {
    version: 1;
    authority: string;
    ignorePatterns: string[];
    files: Record<string, FileEntry>;
}

export class HistoryCheckpoints {
    constructor(private adapter: DataAdapter, private root: string, private authority: string) {}

    /** Removes inventories no sync history entry references; run before accepting sync work. */
    async prune(retained: string[]): Promise<void> {
        if (!await this.adapter.exists(this.root)) return;
        const keep = new Set(retained.map(id => `${this.root}/${id}.json`));
        for (const path of (await this.adapter.list(this.root)).files) {
            if (/^[a-f0-9]{64}\.json$/.test(path.slice(this.root.length + 1)) && !keep.has(path)) await this.adapter.remove(path);
        }
    }

    async load(id: string, ignorePatterns: string[]): Promise<HistoryCheckpoint> {
        if (!isSha256Hex(id)) throw new Error('This entry has no complete vault checkpoint.');
        const path = `${this.root}/${id}.json`;
        if (!await this.adapter.exists(path)) throw new Error('This checkpoint is no longer available on this device.');
        const text = await this.adapter.read(path);
        if (await sha256Hex(new TextEncoder().encode(text).buffer) !== id) throw new Error('The history checkpoint is damaged. No files were changed.');
        const value: unknown = JSON.parse(text);
        if (!isRecord(value) || value.version !== 1 || value.authority !== this.authority) throw new Error('This checkpoint belongs to a different sync connection.');
        if (JSON.stringify(value.ignorePatterns) !== JSON.stringify(ignorePatterns)) throw new Error('Sync exclusions have changed since this checkpoint. Restore the previous exclusions before returning to this state.');
        const files = parseSyncFiles(value.files, true);
        assertPortablePaths(Object.keys(files));
        return { version: 1, authority: this.authority, ignorePatterns, files };
    }
}
