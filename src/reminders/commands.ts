import { FuzzySuggestModal, Notice } from "obsidian";
import type CratePlugin from "@/main";
import { openCompactReminderModal, openReminderCreationModal } from "@/reminders/ui/adapters/modals";
import { recoverInterruptedReminderMoves } from './runtime';

class ProjectSuggestModal extends FuzzySuggestModal<string> {
  private readonly plugin: CratePlugin;

  constructor(plugin: CratePlugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.setPlaceholder("Switch to project...");
  }

  getItems(): string[] {
    return this.plugin.reminderRepository.getProjects();
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string): void {
    openCompactReminderModal(this.plugin, item);
  }
}

export function registerReminderCommands(plugin: CratePlugin) {
  plugin.addCommand({
    id: 'recover-reminder-moves',
    name: 'Recover interrupted reminder moves',
    callback: () => { if (!plugin.remindersSettings.enabled) return; void recoverInterruptedReminderMoves(plugin).catch((error: unknown) => new Notice(error instanceof Error ? error.message : 'Reminder move recovery failed.')); },
  });
  plugin.addCommand({
    id: "create-reminder",
    name: "Create reminder",
    callback: () => {
      if (!plugin.remindersSettings.enabled) { new Notice("Enable reminders in Crate settings first."); return; }
      openReminderCreationModal(plugin);
    },
  });

  plugin.addCommand({
    id: "open-project",
    name: "Open project",
    callback: () => {
      if (!plugin.remindersSettings.enabled) { new Notice("Enable reminders in Crate settings first."); return; }
      const projects = plugin.reminderRepository.getProjects();
      if (projects.length === 0) {
        new Notice("No projects found. Create a reminder first.");
        return;
      }
      new ProjectSuggestModal(plugin).open();
    },
  });
}
