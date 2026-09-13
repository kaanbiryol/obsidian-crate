import type { SyncActivityProgress } from '../../sync/types';

export function formatSyncProgress(progress?: SyncActivityProgress | null): string {
    if (progress?.type === 'initial') {
        return progress.total > 0
            ? `Preparing vault files: ${progress.current}/${progress.total}. Uploading vault…`
            : 'Preparing vault upload…';
    }
    if (!progress || progress.total === 0) return 'Checking for changes…';
    return `Processing changes: ${progress.current}/${progress.total}. Unchanged files are skipped.`;
}
