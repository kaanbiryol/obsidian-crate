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

import { TAbstractFile, TFile, TFolder, type App } from "obsidian";
import {
  getProjectFromPath as deriveProjectFromPath,
  scanReminderMarkdownContent,
} from "@/reminders/core/markdownScan";
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

interface FileScanResult {
  filePath: string;
  reminders: IndexedReminder[];
  lineCount: number;
}

/**
 * Check if a file is within the reminders folder
 */
export function isInRemindersFolder(filePath: string, remindersFolderPath: string): boolean {
  // Normalize paths for case-insensitive comparison
  const normalizedFile = filePath.toLowerCase();
  const normalizedFolder = remindersFolderPath.replace(/^\/|\/$/g, '').toLowerCase();
  return normalizedFile.startsWith(normalizedFolder + "/") || normalizedFile === normalizedFolder;
}

function collectMarkdownFilesInFolder(app: App, remindersFolderPath: string): TFile[] {
  const normalizedFolderPath = remindersFolderPath.replace(/^\/|\/$/g, '');
  let rootEntry: TAbstractFile | null = null;

  if (!normalizedFolderPath) {
    const vaultWithRoot = app.vault as unknown as { getRoot?: () => TFolder };
    rootEntry = vaultWithRoot.getRoot ? vaultWithRoot.getRoot() : null;
    if (!rootEntry) {
      return app.vault.getMarkdownFiles();
    }
  } else {
    const vault = app.vault as unknown as {
      getAbstractFileByPath?: (path: string) => TAbstractFile | null;
      getMarkdownFiles?: () => TFile[];
    };
    if (typeof vault.getAbstractFileByPath === 'function') {
      rootEntry = vault.getAbstractFileByPath(normalizedFolderPath);
    } else if (typeof vault.getMarkdownFiles === 'function') {
      return vault
        .getMarkdownFiles()
        .filter((file) => isInRemindersFolder(file.path, remindersFolderPath));
    } else {
      rootEntry = null;
    }
  }

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
  remindersFolderPath: string
): Promise<FileScanResult> {
  const filePath = file.path;

  try {
    const content = await app.vault.cachedRead(file);
    const result = scanReminderMarkdownContent(filePath, content, remindersFolderPath);

    return {
      filePath,
      reminders: result.reminders,
      lineCount: result.lineCount,
    };
  } catch (error) {
    log.error(` Error scanning file ${filePath}:`, error);
    return {
      filePath,
      reminders: [],
      lineCount: 0,
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
  remindersFolderPath: string
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

  // Scan files in batches for better performance
  const BATCH_SIZE = 50;
  for (let i = 0; i < reminderFiles.length; i += BATCH_SIZE) {
    const batch = reminderFiles.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((file) => scanFile(app, file, remindersFolderPath))
    );

    for (const result of results) {
      allReminders.push(...result.reminders);
      totalLines += result.lineCount;
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
