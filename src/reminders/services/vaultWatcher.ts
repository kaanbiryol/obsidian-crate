/**
 * Vault Watcher - Watches vault for file changes and updates the reminder index
 *
 * Hooks into Obsidian's vault events:
 * - modify: Re-scan the changed file
 * - create: Scan the new file
 * - delete: Remove entries for the file
 * - rename: Update file paths in the index
 */

import { TFile, type TAbstractFile, type EventRef } from "obsidian";
import { createLogger } from "@/reminders/utils/logger";
import type CratePlugin from "@/main";
import type { ReminderIndex } from "@/reminders/data/reminder-index";

const log = createLogger('VaultWatcher');

export class VaultWatcher {
  private plugin: CratePlugin;
  private index: ReminderIndex;
  private eventRefs: EventRef[] = [];
  private pendingIndexChangedNotification: number | null = null;

  // Debounce file modifications to avoid excessive rescans
  private pendingScans: Map<string, number> = new Map();
  private static DEBOUNCE_MS = 1500;

  constructor(
    plugin: CratePlugin,
    index: ReminderIndex,
    private onIndexChanged?: () => Promise<void> | void,
  ) {
    this.plugin = plugin;
    this.index = index;
  }

  /**
   * Register all vault event listeners
   */
  register(): void {
    // File modified
    this.eventRefs.push(
      this.plugin.app.vault.on("modify", (file) => {
        this.handleModify(file);
      })
    );

    // File created
    this.eventRefs.push(
      this.plugin.app.vault.on("create", (file) => {
        void this.handleCreate(file);
      })
    );

    // File deleted
    this.eventRefs.push(
      this.plugin.app.vault.on("delete", (file) => {
        this.handleDelete(file);
      })
    );

    // File renamed
    this.eventRefs.push(
      this.plugin.app.vault.on("rename", (file, oldPath) => {
        void this.handleRename(file, oldPath);
      })
    );

    log.info(" Registered vault event listeners");
  }

  /**
   * Unregister all event listeners
   */
  unregister(): void {
    for (const ref of this.eventRefs) {
      this.plugin.app.vault.offref(ref);
    }
    this.eventRefs = [];

    // Clear any pending scans
    for (const timeout of this.pendingScans.values()) {
      clearTimeout(timeout);
    }
    this.pendingScans.clear();
    if (this.pendingIndexChangedNotification !== null) {
      clearTimeout(this.pendingIndexChangedNotification);
      this.pendingIndexChangedNotification = null;
    }

    log.info(" Unregistered vault event listeners");
  }

  /**
   * Handle file modification - debounced rescan
   */
  private handleModify(file: TAbstractFile): void {
    if (!this.isMarkdownFile(file)) return;
    if (!this.index.isReminderFile(file.path)) return; // Only watch reminders folder

    const filePath = file.path;

    // Clear any pending scan for this file
    const existing = this.pendingScans.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    // Schedule a debounced scan
    const timeout = window.setTimeout(() => {
      this.pendingScans.delete(filePath);
      void this.rescanAndNotify(file);
    }, VaultWatcher.DEBOUNCE_MS);

    this.pendingScans.set(filePath, timeout);
  }

  /**
   * Handle file creation - scan for reminders
   */
  private async handleCreate(file: TAbstractFile): Promise<void> {
    if (!this.isMarkdownFile(file)) return;
    if (!this.index.isReminderFile(file.path)) return; // Only watch reminders folder

    log.info(` New reminder file created: ${file.path}`);
    await this.rescanAndNotify(file);
  }

  /**
   * Handle file deletion - remove from index
   */
  private handleDelete(file: TAbstractFile): void {
    if (!this.isMarkdownFile(file)) return;
    if (!this.index.isReminderFile(file.path)) return; // Only watch reminders folder

    log.info(` Reminder file deleted: ${file.path}`);

    // Clear any pending scan for this file
    const existing = this.pendingScans.get(file.path);
    if (existing) {
      clearTimeout(existing);
      this.pendingScans.delete(file.path);
    }

    this.index.removeFile(file.path);
    this.scheduleIndexChangedNotification();
  }

  /**
   * Handle file rename - update paths in index
   */
  private async handleRename(file: TAbstractFile, oldPath: string): Promise<void> {
    if (!this.isMarkdownFile(file)) return;

    const wasInFolder = this.index.isReminderFile(oldPath);
    const nowInFolder = this.index.isReminderFile(file.path);

    // Update pending scans if any
    const existing = this.pendingScans.get(oldPath);
    if (existing) {
      clearTimeout(existing);
      this.pendingScans.delete(oldPath);
    }

    if (wasInFolder && nowInFolder) {
      // Moved within reminders folder - update path
      log.info(` Reminder file renamed: ${oldPath} -> ${file.path}`);
      this.index.renameFile(oldPath, file.path);
      this.scheduleIndexChangedNotification();
    } else if (wasInFolder && !nowInFolder) {
      // Moved out of reminders folder - remove
      log.info(` File moved out of reminders folder: ${oldPath}`);
      this.index.removeFile(oldPath);
      this.scheduleIndexChangedNotification();
    } else if (!wasInFolder && nowInFolder) {
      // Moved into reminders folder - scan
      log.info(` File moved into reminders folder: ${file.path}`);
      await this.rescanAndNotify(file);
    }
    // If neither was in folder, ignore
  }

  /**
   * Check if file is a markdown file
   */
  private isMarkdownFile(file: TAbstractFile): file is TFile {
    return file instanceof TFile && file.extension === "md";
  }

  private async rescanAndNotify(file: TFile): Promise<void> {
    await this.index.rescanFile(file);
    this.scheduleIndexChangedNotification();
  }

  private scheduleIndexChangedNotification(): void {
    if (!this.onIndexChanged) return;
    if (this.pendingIndexChangedNotification !== null) {
      clearTimeout(this.pendingIndexChangedNotification);
    }
    this.pendingIndexChangedNotification = window.setTimeout(() => {
      this.pendingIndexChangedNotification = null;
      void Promise.resolve(this.onIndexChanged?.()).catch((error: unknown) => {
        log.warn('Failed to reconcile reminder notifications after a vault change:', error);
      });
    }, 0);
  }
}
