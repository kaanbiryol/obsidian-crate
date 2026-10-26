import { processVaultMarkdown } from '@/sync/local/vault-markdown';
import { createReminderId } from "../../core/reminderIdentity";
import { noteContainsReminderId } from "../../core/markdownReminderFile";
import type { IndexedReminder } from "../reminder-index";
import {
	appendCreatedReminderBlock,
	buildCreatedReminderBlock,
	reminderBlockFields,
} from "../../core/markdownReminderMutation";
import { requireReminderProjectPath } from "../../core/reminderProjectPath";
import type { CreateReminderInput, MarkdownWriterContext } from "./types";
import { markdownWriterLog } from "./helpers";

export async function createReminderInMarkdown(
	context: MarkdownWriterContext,
	{ project, content, dueDate, priority, recurrence, hasTime, reminderId, description }: CreateReminderInput,
): Promise<void> {
	const normalizedProject = requireReminderProjectPath(project);
	const stableReminderId = reminderId ?? createReminderId();
	if (context.index.getById(stableReminderId)) throw new Error('This reminder already exists. Close the draft and refresh to see its saved state.');
	// Building first refuses a title that would not read back before any file is created.
	const mutation = buildCreatedReminderBlock({
		content,
		description,
		dueDate,
		priority,
		recurrence,
		hasTime,
		reminderId: stableReminderId,
	});
	const file = await context.getOrCreateProjectFile(normalizedProject);

	const optimisticReminder: IndexedReminder = {
		id: stableReminderId,
		...reminderBlockFields(mutation),
		completed: false,
		project: normalizedProject,
		filePath: file.path,
		lineNumber: -1,
		rawLine: mutation.checkboxLine,
	};

	context.index.applyOptimisticCreate(optimisticReminder);

	try {
		await processVaultMarkdown(context.app.vault, file, (fileContent) => {
			context.moveJournal?.assertActive();
			// A lost local write acknowledgement must not append the same identity twice.
			if (noteContainsReminderId(fileContent, stableReminderId)) {
				throw new Error('This reminder already exists. Close the draft and refresh to see its saved state.');
			}
			return appendCreatedReminderBlock(fileContent, mutation);
		});
		markdownWriterLog.info(`Created reminder in ${file.path}`);
		await context.index.rescanFile(file);

	} catch (error) {
		context.index.clearOptimistic(stableReminderId);
		throw error;
	}
}
