import { TFile, type TAbstractFile } from "obsidian";
import { createLogger } from "@/reminders";
import type CratePlugin from "@/main";

const log = createLogger('FileRenameHandler');

/**
 * FileRenameHandler - Updates reminder fileLinks when files are renamed
 *
 * Listens to Obsidian's vault rename event and updates all reminders
 * that have a fileLink matching the old file path.
 */
export class FileRenameHandler {
  private plugin: CratePlugin;

  constructor(plugin: CratePlugin) {
    this.plugin = plugin;
  }

  /**
   * Register file rename listener
   */
  register(): void {
    this.plugin.registerEvent(
      this.plugin.app.vault.on("rename", (file, oldPath) => {
        void this.handleRename(file, oldPath);
      })
    );

    log.info(" Registered file rename listener");
  }

  /**
   * Handle file rename event
   */
  private async handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
    // Only handle markdown files
    if (!this.isMarkdownFile(file)) {
      return;
    }

    const newPath = file.path;

    if (this.plugin.remindersSettings.debugLogging) {
      log.info(` File renamed: "${oldPath}" -> "${newPath}"`);
    }

    try {
      // Update all reminders with the old file path to use the new path
      const updatedCount = await this.plugin.storage.updateFileLinks(oldPath, newPath);

      if (updatedCount > 0) {
        log.info(` Updated ${updatedCount} reminder(s) with new file path`);
      } else if (this.plugin.remindersSettings.debugLogging) {
        log.info(` No reminders linked to "${oldPath}"`);
      }
    } catch (error) {
      log.error(` Failed to update reminders for renamed file:`, error);
    }
  }

  /**
   * Check if file is a markdown file
   */
  private isMarkdownFile(file: TAbstractFile): file is TFile {
    return file instanceof TFile && file.extension === "md";
  }
}
