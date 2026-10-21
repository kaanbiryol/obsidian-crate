import { FuzzySuggestModal, Notice } from "obsidian";
import type CratePlugin from "@/main";
import { openReminderCreationModal } from "@/reminders/ui/plugin/reminderEditorModals";
import { openCompactReminderModal } from "@/reminders/ui/plugin/remindersViewModals";

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
