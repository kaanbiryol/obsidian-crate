import type { App, TFile } from 'obsidian';
import { isReminderNotePath, reminderArchiveNotePath } from '@/protocol/reminder-archive-path';
import type { ReminderIndex } from './reminder-index';
import type { ReminderMoveJournal } from './reminder-move-journal';
import { ensureFolderPath, getFile } from './markdown-writer/helpers';

export interface ReminderArchiveSummary {
	archived: number;
	skipped: number;
	/** Notes whose reminders were archived. */
	notes: number;
	/** Notes left unchanged after an error, with its message. */
	failures: Array<{ path: string; error: string }>;
	/** Sync started writing the vault, so the remaining notes were left for another run. */
	deferred: boolean;
}

export interface ReminderArchiveDeps {
	app: App;
	index: Pick<ReminderIndex, 'remindersFolderPath' | 'rescanFile' | 'flushDeferredScans'>;
	journal: Pick<ReminderMoveJournal, 'archive' | 'assertActive'>;
	isWritingVault: () => boolean;
}

/** Notes holding completed reminders, sorted by path. */
export function notesWithCompletedReminders(reminders: ReadonlyArray<{ completed: boolean; filePath: string }>): string[] {
	return [...new Set(reminders.filter(reminder => reminder.completed).map(reminder => reminder.filePath))].sort();
}

/** Archives each note in turn, so one failure leaves the other notes archived. */
export async function archiveCompletedReminders(deps: ReminderArchiveDeps, notePaths: readonly string[]): Promise<ReminderArchiveSummary> {
	const { app, index, journal } = deps;
	const folder = index.remindersFolderPath;
	const summary: ReminderArchiveSummary = { archived: 0, skipped: 0, notes: 0, failures: [], deferred: false };
	for (const path of notePaths) {
		if (!isReminderNotePath(path, folder)) continue;
		// Sync may be replacing these notes; archiving stops instead of racing it.
		if (deps.isWritingVault()) { summary.deferred = true; break; }
		const destination = reminderArchiveNotePath(folder, path);
		try {
			const result = await journal.archive(path, destination, async () => {
				await ensureFolderPath(app, destination.slice(0, destination.lastIndexOf('/')));
				if (!await getFile(app, destination)) await app.vault.create(destination, '');
				const file = await getFile(app, destination);
				if (!file) throw new Error(`Could not create archive note: ${destination}`);
				return file;
			});
			summary.archived += result.archived;
			summary.skipped += result.skipped;
			if (result.archived) summary.notes++;
		} catch (error) {
			// The plugin is unloading: stop instead of failing every remaining note.
			journal.assertActive();
			summary.failures.push({ path, error: error instanceof Error ? error.message : 'Archive failed' });
		}
		const file: TFile | null = await getFile(app, path);
		if (file) await index.rescanFile(file);
	}
	await index.flushDeferredScans();
	return summary;
}
