import { isMarkdownNoteInFolder } from './note-paths';
import { portablePathKey } from './portable-path';

/** Completed reminders moved out of their projects live in this subfolder of the
 * reminders folder. It is never a project, so nothing indexes, lists or schedules it. */
const REMINDER_ARCHIVE_FOLDER = 'Archive';

export function reminderArchiveFolder(folder: string): string {
	return `${folder}/${REMINDER_ARCHIVE_FOLDER}`;
}

/** Below the archive folder in any letter case or Unicode form, as devices compare paths. */
export function isReminderArchivePath(path: string, folder: string): boolean {
	return portablePathKey(path).startsWith(`${portablePathKey(reminderArchiveFolder(folder))}/`);
}

/** A project note: Markdown below the reminders folder and outside its archive. */
export function isReminderNotePath(path: string, folder: string): boolean {
	return isMarkdownNoteInFolder(path, folder) && !isReminderArchivePath(path, folder);
}

/** A project path that would place its note inside the archive. */
export function isReminderArchiveProject(project: string): boolean {
	return portablePathKey(project).startsWith(`${portablePathKey(REMINDER_ARCHIVE_FOLDER)}/`);
}

/** The archive note that receives a project note's completed reminders. */
export function reminderArchiveNotePath(folder: string, projectNotePath: string): string {
	return `${reminderArchiveFolder(folder)}/${projectNotePath.slice(folder.length + 1)}`;
}
