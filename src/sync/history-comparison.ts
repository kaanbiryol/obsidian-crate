import type { FileEntry } from '../protocol/sync-types';
import { loadHistoryRestorePreview, type HistoryRestorePreview } from './history-restore-preview';

export interface HistorySnapshot {
    files: Record<string, FileEntry>;
    read(path: string, file: FileEntry): Promise<ArrayBuffer>;
}
interface HistoryFileChange { path: string; action: 'added' | 'modified' | 'deleted' | 'saved' }
export interface HistoryComparison {
    items: HistoryFileChange[];
    compared: boolean;
    notice?: string;
    retryable?: boolean;
    preview(path: string): Promise<HistoryRestorePreview>;
}

/** Compare two immutable inventories. Current local files never participate. */
export function compareHistorySnapshots(after: HistorySnapshot, before?: HistorySnapshot, notice?: string): HistoryComparison {
    const saved: Record<string, FileEntry> = Object.assign(Object.create(null) as Record<string, FileEntry>, after.files);
    const earlier: Record<string, FileEntry> = Object.assign(Object.create(null) as Record<string, FileEntry>, before?.files);
    const paths = [...new Set([...Object.keys(saved), ...Object.keys(earlier)])].sort();
    const items: HistoryFileChange[] = paths.filter(path => !before || earlier[path]?.hash !== saved[path]?.hash).map(path => ({
        path, action: !before ? 'saved' : !saved[path] ? 'deleted' : !earlier[path] ? 'added' : 'modified',
    }));
    return {
        items, compared: !!before, notice,
        preview: async path => {
            if (!items.some(item => item.path === path)) throw new Error('This file is not in the selected sync.');
            return loadHistoryRestorePreview(path, earlier[path], saved[path],
                () => before!.read(path, earlier[path]!), () => after.read(path, saved[path]!));
        },
    };
}
