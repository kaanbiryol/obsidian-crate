import { FuzzySuggestModal, Notice } from "obsidian";
import type CratePlugin from "@/plugin/CratePlugin";
import { openReminderCreationModal } from "@/reminders/ui/plugin/reminder-modal/reminderEditorModals";
import { openCompactReminderModal } from "@/reminders/ui/plugin/remindersViewModals";
import { requireReminderBackend } from "@/reminders/runtime";
import { notesWithCompletedReminders, type ReminderArchiveSummary } from "@/reminders/data/reminder-archive-runner";
import { reminderProject } from "@/reminders/core/reminderProjectPath";

class ProjectSuggestModal extends FuzzySuggestModal<string> {
	private readonly plugin: CratePlugin;

	constructor(plugin: CratePlugin) {
		super(plugin.app);
		this.plugin = plugin;
		this.setPlaceholder("Switch to project...");
	}

	getItems(): string[] {
		return this.plugin.reminders?.repository.getProjects() ?? [];
	}

	getItemText(item: string): string {
		return item;
	}

	onChooseItem(item: string): void {
		openCompactReminderModal(this.plugin, item);
	}
}

interface ArchiveChoice {
	label: string;
	notePaths: string[];
}

class ArchiveProjectModal extends FuzzySuggestModal<ArchiveChoice> {
	constructor(plugin: CratePlugin, private readonly choices: ArchiveChoice[], private readonly onChoose: (choice: ArchiveChoice) => void) {
		super(plugin.app);
		this.setPlaceholder("Archive completed reminders from...");
	}

	getItems(): ArchiveChoice[] {
		return this.choices;
	}

	getItemText(item: ArchiveChoice): string {
		return item.label;
	}

	onChooseItem(item: ArchiveChoice): void {
		this.onChoose(item);
	}
}

function archiveSummaryText({ archived, skipped, notes, failures, deferred }: ReminderArchiveSummary): string {
	const lines = archived
		? [`Archived ${archived} completed ${archived === 1 ? "reminder" : "reminders"} from ${notes} ${notes === 1 ? "note" : "notes"}.`]
		: deferred ? [] : ["No completed reminders were archived."];
	if (skipped) lines.push(`${skipped} completed ${skipped === 1 ? "reminder" : "reminders"} stayed in place: nested, with subtasks or sharing an ID.`);
	for (const failure of failures) lines.push(`${failure.path} was not archived: ${failure.error}`);
	if (deferred) lines.push(archived ? "Sync started before every note was archived. Wait for it to finish, then archive again." : "Wait for sync to finish, then archive again.");
	return lines.join("\n");
}

function openArchiveCompletedReminders(plugin: CratePlugin) {
	const backend = requireReminderBackend(plugin);
	const reminders = backend.index.getAll();
	const notePaths = notesWithCompletedReminders(reminders);
	if (notePaths.length === 0) {
		new Notice("No completed reminders to archive.");
		return;
	}
	const projectOf = new Map(reminders.map(reminder => [reminder.filePath, reminderProject(reminder)]));
	const choices: ArchiveChoice[] = [
		{ label: "All projects", notePaths },
		...notePaths.map(path => ({ label: projectOf.get(path) ?? path, notePaths: [path] })),
	];
	new ArchiveProjectModal(plugin, choices, choice => {
		void backend.archiveCompleted(choice.notePaths).then(
			summary => new Notice(archiveSummaryText(summary), summary.failures.length || summary.deferred ? 0 : undefined),
			(error: unknown) => new Notice(error instanceof Error ? error.message : "Could not archive reminders.", 0),
		);
	}).open();
}

export function registerReminderCommands(plugin: CratePlugin) {
	plugin.addCommand({
		id: "create-reminder",
		name: "Create reminder",
		callback: () => {
			if (!plugin.remindersSettings.enabled) { new Notice("Enable reminders in Crate settings first."); return; }
			openReminderCreationModal(plugin);
		},
	});

	plugin.addCommand({
		id: "archive-completed-reminders",
		name: "Archive completed reminders",
		callback: () => {
			if (!plugin.remindersSettings.enabled) { new Notice("Enable reminders in Crate settings first."); return; }
			try { openArchiveCompletedReminders(plugin); }
			catch (error) { new Notice(error instanceof Error ? error.message : "Could not archive reminders."); }
		},
	});

	plugin.addCommand({
		id: "open-project",
		name: "Open reminder project",
		callback: () => {
			if (!plugin.remindersSettings.enabled) { new Notice("Enable reminders in Crate settings first."); return; }
			const projects = plugin.reminders?.repository.getProjects() ?? [];
			if (projects.length === 0) {
				new Notice("No projects found. Create a reminder first.");
				return;
			}
			new ProjectSuggestModal(plugin).open();
		},
	});
}
