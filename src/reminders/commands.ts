import { Notice } from "obsidian";
import type CratePlugin from "@/main";
import { openReminderCreationModal } from "@/reminders/ui/modals";

export function registerReminderCommands(plugin: CratePlugin) {
  plugin.addCommand({
    id: "create-reminder",
    name: "Create reminder",
    callback: () => {
      openReminderCreationModal(plugin);
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
