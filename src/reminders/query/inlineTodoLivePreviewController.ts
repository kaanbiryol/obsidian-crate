import { TFile } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import { createLogger } from '@/reminders';
import type CratePlugin from '@/main';
import { isInRemindersFolder } from '@/reminders/data/vaultScanner';
import type { Reminder } from '@/reminders/types/plugin-reminder';
import {
	getLineReminderMappingService,
	type LineReminderMappingService,
} from '@/reminders/services/lineReminderMapping';
import {
	isCheckboxLine,
	parseCheckboxLine,
} from '@/reminders/utils/checkboxParser';
import {
	buildStoredReminderDates,
	parseStoredReminderDate,
	reminderHasTime,
} from '@/reminders/utils/reminderDate';

const log = createLogger('InlineTodo');

export interface InlineTodoController {
	reconcileFile(view: EditorView, filePath: string): Promise<void>;
	processLineOnLeave(view: EditorView, filePath: string, lineNum: number): Promise<void>;
}

function hasReminderChanged(
	reminder: Reminder,
	parsed: NonNullable<ReturnType<typeof parseCheckboxLine>>,
): boolean {
	if (reminder.completed !== parsed.isCompleted) {
		return true;
	}
	if (reminder.priority !== parsed.parsed.priority) {
		return true;
	}
	if (parsed.parsed.project && reminder.project !== parsed.parsed.project) {
		return true;
	}

	const reminderDate = parseStoredReminderDate(reminder);
	const parsedDate = parsed.parsed.dueDate;
	if (!reminderDate && !parsedDate) {
		return false;
	}
	if (!reminderDate || !parsedDate) {
		return true;
	}
	if ((reminderHasTime(reminder) ?? false) !== (parsed.parsed.hasTime ?? false)) {
		return true;
	}

	return Math.abs(reminderDate.getTime() - parsedDate.getTime()) > 60000;
}

export function createInlineTodoController(
	plugin: CratePlugin,
	mappingService: LineReminderMappingService = getLineReminderMappingService(),
): InlineTodoController {
	const reminderCache = new Map<string, Map<string, Reminder>>();

	async function reconcileFile(view: EditorView, filePath: string): Promise<void> {
		const remindersFolderPath = plugin.remindersSettings.remindersFolderPath;
		if (!isInRemindersFolder(filePath, remindersFolderPath)) {
			return;
		}

		try {
			const reminders = plugin.storage.getByFile(filePath);
			const checkboxLines: Array<{ lineNumber: number; content: string }> = [];
			const doc = view.state.doc;

			for (let index = 1; index <= doc.lines; index++) {
				const line = doc.line(index);
				if (!isCheckboxLine(line.text)) {
					continue;
				}
				const parsed = parseCheckboxLine(line.text);
				if (parsed) {
					checkboxLines.push({
						lineNumber: index,
						content: parsed.rawContent,
					});
				}
			}

			const result = mappingService.reconcile(filePath, reminders, checkboxLines);

			log.info(`Reconciliation for ${filePath}:`, {
				remindersFromStorage: reminders.length,
				checkboxLines: checkboxLines.length,
				matched: result.matched.length,
				orphaned: result.orphaned.length,
				unmapped: result.unmapped.length,
			});

			for (const { lineNumber, reminder } of result.matched) {
				log.info(`Matched line ${lineNumber} to reminder:`, {
					id: reminder.id,
					content: reminder.content,
					project: reminder.project,
				});
			}

			const fileCache = new Map<string, Reminder>();
			for (const { reminder } of result.matched) {
				fileCache.set(reminder.id, reminder);
			}
			reminderCache.set(filePath, fileCache);

			if (result.unmapped.length === 0) {
				return;
			}

			log.info(`Processing ${result.unmapped.length} unmapped lines in batch`);
			const file = plugin.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) {
				await plugin.reminderIndex.rescanFile(file, true);
			}

			const indexedReminders = plugin.reminderIndex.getByFile(filePath);
			const indexedByContent = new Map<string, typeof indexedReminders[0]>();
			for (const indexedReminder of indexedReminders) {
				indexedByContent.set(indexedReminder.content, indexedReminder);
			}

			let cachedReminders = reminderCache.get(filePath);
			if (!cachedReminders) {
				cachedReminders = new Map();
				reminderCache.set(filePath, cachedReminders);
			}

			for (const { lineNumber, content } of result.unmapped) {
				const parsed = parseCheckboxLine(`- [ ] ${content}`);
				if (!parsed || !parsed.parsed.cleanContent.trim()) {
					continue;
				}

				const cleanContent = parsed.parsed.cleanContent;
				const indexedReminder = indexedByContent.get(cleanContent);
				if (!indexedReminder) {
					log.warn(`Could not find indexed reminder for line ${lineNumber} with content: ${cleanContent.substring(0, 50)}`);
					continue;
				}

				const reminder: Reminder = {
					id: indexedReminder.id,
					content: indexedReminder.content,
					dueDate: indexedReminder.dueDate,
					dueDatetime: indexedReminder.dueDatetime,
					priority: indexedReminder.priority,
					completed: indexedReminder.completed,
					project: indexedReminder.project,
					fileLink: indexedReminder.filePath,
					recurrence: indexedReminder.recurrence,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				};

				mappingService.registerLine(filePath, lineNumber, reminder.id, content);
				cachedReminders.set(reminder.id, reminder);
				log.info(`Matched unmapped line ${lineNumber} to indexed reminder ${reminder.id}`);
			}
		} catch (error) {
			log.error('Failed to reconcile file:', error);
		}
	}

	async function updateReminderFromLine(
		reminderId: string,
		parsed: NonNullable<ReturnType<typeof parseCheckboxLine>>,
		filePath: string,
	): Promise<void> {
		const storedDates = buildStoredReminderDates(parsed.parsed.dueDate, parsed.parsed.hasTime);

		const existingReminder = reminderCache.get(filePath)?.get(reminderId);
		const oldProject = existingReminder?.project;
		const newProject = parsed.parsed.project;
		const projectChanged = newProject && oldProject && newProject !== oldProject;

		try {
			const updated = await plugin.storage.update(reminderId, {
				content: parsed.parsed.cleanContent,
				dueDate: storedDates.dueDate,
				dueDatetime: storedDates.dueDatetime,
				priority: parsed.parsed.priority,
				project: parsed.parsed.project || undefined,
				recurrence: parsed.parsed.recurrence ?? null,
				completed: parsed.isCompleted,
			});

			if (projectChanged) {
				log.info(`Reminder ${reminderId} moved to project ${newProject}, cleaning up cache`);
				reminderCache.get(filePath)?.delete(reminderId);
				mappingService.unregisterReminder(reminderId);
			} else if (updated) {
				reminderCache.get(filePath)?.set(reminderId, updated);
				log.info(`Updated reminder ${reminderId}`);
			}
		} catch (error) {
			log.error('Failed to update reminder:', error);
		}
	}

	async function processLineOnLeave(view: EditorView, filePath: string, lineNum: number): Promise<void> {
		const doc = view.state.doc;
		if (lineNum < 1 || lineNum > doc.lines) {
			return;
		}

		const line = doc.line(lineNum);
		if (!isCheckboxLine(line.text)) {
			return;
		}

		const parsed = parseCheckboxLine(line.text);
		if (!parsed || !parsed.parsed.cleanContent.trim()) {
			return;
		}

		const fileCache = reminderCache.get(filePath);
		if (fileCache) {
			for (const reminder of fileCache.values()) {
				if (reminder.content !== parsed.parsed.cleanContent) {
					continue;
				}
				mappingService.registerLine(filePath, lineNum, reminder.id, line.text);
				if (hasReminderChanged(reminder, parsed)) {
					await updateReminderFromLine(reminder.id, parsed, filePath);
				}
				return;
			}
		}

		const existingReminderId = mappingService.getReminderForLine(filePath, lineNum);
		if (!existingReminderId || !fileCache) {
			return;
		}

		const existingReminder = fileCache.get(existingReminderId);
		if (!existingReminder) {
			return;
		}

		if (existingReminder.content === parsed.parsed.cleanContent && hasReminderChanged(existingReminder, parsed)) {
			await updateReminderFromLine(existingReminderId, parsed, filePath);
		}
	}

	return {
		reconcileFile,
		processLineOnLeave,
	};
}
