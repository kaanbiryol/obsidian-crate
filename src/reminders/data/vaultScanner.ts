/**
 * Vault Scanner - Scans a specific folder for reminder syntax in markdown files
 *
 * Only scans files within the configured reminders folder.
 * Each file represents a project (filename = project name).
 *
 * Finds markdown checkbox lines:
 * - [ ] task content @date #project !
 * - [x] completed task
 */

import { normalizePath, TAbstractFile, TFile, TFolder, type App } from "obsidian";
import {
  getProjectFromPath as deriveProjectFromPath,
  scanReminderMarkdownContent,
} from "@/reminders/core/markdownScan";
import { createReminderId, setReminderIdMarker } from "@/reminders/core/reminderIdentity";
import { parseCheckboxLine } from "@/reminders/utils/checkboxParser";
import { createLogger } from "@/reminders/utils/logger";
import type { IndexedReminder } from "./reminder-index";

const log = createLogger('VaultScanner');

export { getProjectFromPath } from "@/reminders/core/markdownScan";

export interface ScanResult {
  reminders: IndexedReminder[];
  filesScanned: number;
  totalLines: number;
  scanDurationMs: number;
  discoveredProjects: string[]; // All projects from file paths, including empty ones
}

export interface FileScanResult {
  filePath: string;
  reminders: IndexedReminder[];
  lineCount: number;
  error?: string;
}

export interface ReminderIdNormalizationResult {
  content: string;
  remindersUpdated: number;
}

/**
 * Add stable IDs while the file is already being read for indexing. This keeps
 * manually-authored checkboxes discoverable without a separate vault-wide
 * rewrite.
 */
function createUniqueReminderId(usedIds: Set<string>): string {
  let reminderId = createReminderId();
  while (usedIds.has(reminderId)) {
    reminderId = createReminderId();
  }
  return reminderId;
}

export function normalizeReminderIds(
  content: string,
  reservedIds: ReadonlySet<string> = new Set(),
): ReminderIdNormalizationResult {
  const lines = content.split("\n");
  const usedIds = new Set(reservedIds);
  let remindersUpdated = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) continue;
    const parsed = parseCheckboxLine(line);
    if (!parsed || !parsed.parsed.cleanContent.trim()) {
      continue;
    }

    if (parsed.reminderId && !usedIds.has(parsed.reminderId)) {
      usedIds.add(parsed.reminderId);
      continue;
    }

    const reminderId = createUniqueReminderId(usedIds);
    usedIds.add(reminderId);
    lines[index] = setReminderIdMarker(line, reminderId);
    remindersUpdated++;
  }

  return {
    content: remindersUpdated > 0 ? lines.join("\n") : content,
    remindersUpdated,
  };
}

/**
 * Check if a file is within the reminders folder
 */
export function isInRemindersFolder(filePath: string, remindersFolderPath: string): boolean {
  const normalizedFile = normalizePath(filePath);
  const normalizedFolder = normalizePath(remindersFolderPath);
  return normalizedFile.startsWith(normalizedFolder + "/") || normalizedFile === normalizedFolder;
}

function collectMarkdownFilesInFolder(app: App, remindersFolderPath: string): TFile[] {
  const normalizedFolderPath = remindersFolderPath.replace(/^\/|\/$/g, '');
  const rootEntry = normalizedFolderPath
    ? app.vault.getAbstractFileByPath(normalizedFolderPath)
    : app.vault.getRoot();

  if (!rootEntry) {
    log.warn(` Reminders folder not found: ${remindersFolderPath}`);
    return [];
  }

  if (rootEntry instanceof TFile) {
    return rootEntry.extension === "md" ? [rootEntry] : [];
  }

  const files: TFile[] = [];
  const stack: TAbstractFile[] = [rootEntry];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current instanceof TFolder) {
      for (const child of current.children) {
        stack.push(child);
      }
      continue;
    }
    if (current instanceof TFile && current.extension === "md") {
      files.push(current);
    }
  }

  return files;
}

/**
 * Scan a single file for reminders
 * @param app - Obsidian app instance
 * @param file - File to scan
 * @param remindersFolderPath - Path to the reminders folder (for project derivation)
 */
export async function scanFile(
  app: App,
  file: TFile,
  remindersFolderPath: string,
  reservedIds: ReadonlySet<string> = new Set(),
  signal?: AbortSignal,
): Promise<FileScanResult> {
  const filePath = file.path;
  const cancelled = { filePath, reminders: [], lineCount: 0 };
  if (signal?.aborted) return cancelled;

  try {
    const originalContent = await app.vault.cachedRead(file);
    if (signal?.aborted) return cancelled;
    let normalized = normalizeReminderIds(originalContent, reservedIds);
    if (normalized.remindersUpdated > 0) {
      let remindersUpdated = 0;
      const content = await app.vault.process(file, (currentContent) => {
        if (signal?.aborted) return currentContent;
        const currentNormalization = normalizeReminderIds(currentContent, reservedIds);
        remindersUpdated = currentNormalization.remindersUpdated;
        return currentNormalization.content;
      });
      normalized = { content, remindersUpdated };
      if (remindersUpdated > 0) {
        log.info(` Added ${remindersUpdated} reminder identifiers to ${filePath}`);
      }
    }
    if (signal?.aborted) return cancelled;
    const result = scanReminderMarkdownContent(filePath, normalized.content, remindersFolderPath);

    return {
      filePath,
      reminders: result.reminders,
      lineCount: result.lineCount,
    };
  } catch (error) {
    if (signal?.aborted) return cancelled;
    log.error(` Error scanning file ${filePath}:`, error);
    return {
      filePath,
      reminders: [],
      lineCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Scan only the reminders folder for reminder files
 * @param app - Obsidian app instance
 * @param remindersFolderPath - Path to the reminders folder (e.g., "Reminders")
 */
export async function scanVault(
  app: App,
  remindersFolderPath: string,
  signal?: AbortSignal,
): Promise<ScanResult> {
  const startTime = Date.now();
  const allReminders: IndexedReminder[] = [];
  let totalLines = 0;

  // Only get markdown files within the reminders folder tree
  const reminderFiles = collectMarkdownFilesInFolder(app, remindersFolderPath);

  log.info(
    ` Found ${reminderFiles.length} files in ${remindersFolderPath || "vault root"}`
  );

  // Collect all project names from file paths (including empty files)
  const discoveredProjects = new Set<string>();
  for (const file of reminderFiles) {
    const project = deriveProjectFromPath(file.path, remindersFolderPath);
    discoveredProjects.add(project);
  }

  // Scan in stable path order so the first occurrence of a pasted identifier
  // remains canonical and later duplicates receive fresh identifiers.
  reminderFiles.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const usedReminderIds = new Set<string>();
  for (const file of reminderFiles) {
    if (signal?.aborted) break;
    const result = await scanFile(app, file, remindersFolderPath, usedReminderIds, signal);
    if (result.error) continue;
    allReminders.push(...result.reminders);
    totalLines += result.lineCount;
    for (const reminder of result.reminders) {
      usedReminderIds.add(reminder.id);
    }
  }

  const scanDurationMs = Date.now() - startTime;

  log.info(
    ` Scanned ${reminderFiles.length} files, found ${allReminders.length} reminders in ${scanDurationMs}ms`
  );

  return {
    reminders: allReminders,
    filesScanned: reminderFiles.length,
    totalLines,
    scanDurationMs,
    discoveredProjects: Array.from(discoveredProjects).sort(),
  };
}
