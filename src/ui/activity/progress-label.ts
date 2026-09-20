import type { SyncActivityProgress, SyncWork } from '../../sync/types';

const labels: Record<SyncWork['phase'], string> = {
    recovering: 'Recovering uploads',
    server: 'Checking for changes',
    scanning: 'Checking for changes',
    preparing: 'Preparing files',
    uploading: 'Uploading files',
    downloading: 'Downloading files',
    applying: 'Applying changes',
    saving: 'Saving sync progress',
    reminders: 'Preparing reminder schedules',
};

export function formatSyncProgress(progress?: SyncActivityProgress | null, work?: SyncWork): string {
    work ??= progress?.work;
    if (work) {
        const label = labels[work.phase];
        if (work.phase === 'reminders' && work.reminderSetup) {
            const { scanning, remainingFiles, remainingSchedules } = work.reminderSetup;
            if (scanning) return `Checking reminder files… ${remainingFiles} files queued`;
            if (remainingFiles > 0) return `Preparing reminders: ${remainingFiles} files and ${remainingSchedules} schedules remaining`;
            return `${label}: ${remainingSchedules} remaining`;
        }
        if (work.total !== undefined && work.total > 0 && work.current !== undefined) {
            if (work.phase === 'uploading' || work.phase === 'downloading') {
                return `${work.phase === 'uploading' ? 'Uploading' : 'Downloading'} ${work.current.toLocaleString()} of ${work.total.toLocaleString()} files`;
            }
            return `${label}: ${work.current}/${work.total}`;
        }
        if (['uploading', 'downloading', 'applying'].includes(work.phase) && progress?.type === 'sync' && progress.total > 0) {
            return `${label}… ${progress.current}/${progress.total} changes processed`;
        }
        return `${label}…`;
    }
    if (progress?.type === 'initial' && progress.total > 0) return `Preparing files: ${progress.current}/${progress.total}`;
    if (progress && progress.total > 0) return `Processing changes: ${progress.current}/${progress.total}`;
    return 'Starting sync…';
}
