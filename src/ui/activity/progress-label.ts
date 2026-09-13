import type { SyncActivityProgress, SyncWork } from '../../sync/types';

const labels: Record<SyncWork['phase'], string> = {
    recovering: 'Recovering interrupted uploads',
    server: 'Loading server changes',
    scanning: 'Scanning and comparing vault files',
    preparing: 'Preparing files for upload',
    uploading: 'Uploading files',
    downloading: 'Downloading files',
    applying: 'Applying changes and resolving conflicts',
    saving: 'Saving sync progress',
};

export function formatSyncProgress(progress?: SyncActivityProgress | null, work?: SyncWork): string {
    if (work) {
        const label = labels[work.phase];
        if (work.total !== undefined && work.total > 0 && work.current !== undefined) return `${label}: ${work.current}/${work.total}`;
        if (['uploading', 'downloading', 'applying'].includes(work.phase) && progress?.type === 'sync' && progress.total > 0) {
            return `${label}… ${progress.current}/${progress.total} changes processed`;
        }
        return `${label}…`;
    }
    if (progress?.type === 'initial' && progress.total > 0) return `Preparing files for upload: ${progress.current}/${progress.total}`;
    if (progress && progress.total > 0) return `Processing changes: ${progress.current}/${progress.total}. Unchanged files are skipped.`;
    return 'Starting sync…';
}
