import { FuzzySuggestModal, Notice } from "obsidian";
import type CratePlugin from "@/main";
import { openCompactReminderModal, openReminderCreationModal } from "@/reminders/ui/modals";

class ProjectSuggestModal extends FuzzySuggestModal<string> {
  private readonly plugin: CratePlugin;

  constructor(plugin: CratePlugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.setPlaceholder("Switch to project...");
  }

  getItems(): string[] {
    return this.plugin.storage.getProjects();
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
      openReminderCreationModal(plugin);
    },
  });

  plugin.addCommand({
    id: "open-project",
    name: "Open project",
    callback: () => {
      const projects = plugin.storage.getProjects();
      if (projects.length === 0) {
        new Notice("No projects found. Create a reminder first.");
        return;
      }
      new ProjectSuggestModal(plugin).open();
    },
  });

  plugin.addCommand({
    id: "show-storage-stats",
    name: "Show storage statistics",
    callback: () => {
      const stats = plugin.storage.getStats();
      new Notice(
        `Storage Stats:\n` +
        `Active: ${stats.activeCount}\n` +
        `Completed: ${stats.completedCount}\n` +
        `Total: ${stats.totalCount}`,
        5000
      );
    },
  });
}
