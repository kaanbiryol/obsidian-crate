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
import { addReminderIdentityOwners, resolveReminderIdentityOwners, type ReminderIdentityOwner, type ReminderIdentityOwners } from './reminder-identity-owners';
import { normalizeReminderScheduleLine } from '../core/normalizeReminderSchedule';

const log = createLogger('VaultScanner');

export { getProjectFromPath } from "@/reminders/core/markdownScan";

export interface ScanResult {
  reminders: IndexedReminder[];
  filesScanned: number;
  totalLines: number;
  scanDurationMs: number;
  discoveredProjects: string[]; // All projects from file paths, including empty ones
  deferred?: boolean;
  ambiguousOwners?: ReminderIdentityOwner[];
}

export interface FileScanResult {
  filePath: string;
  reminders: IndexedReminder[];
  lineCount: number;
  error?: string;
  releasedOwners?: ReminderIdentityOwner[];
  deferred?: boolean;
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

    const reminderId = parsed.reminderId && !usedIds.has(parsed.reminderId)
      ? parsed.reminderId : createUniqueReminderId(usedIds);
    usedIds.add(reminderId);
    const normalized = setReminderIdMarker(normalizeReminderScheduleLine(line), reminderId);
    if (normalized !== line) {
      lines[index] = normalized;
      remindersUpdated++;
    }
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
  identityOwners?: ReminderIdentityOwners,
  shouldDeferNormalization = () => false,
  shouldDeferCollisionRepair = () => false,
): Promise<FileScanResult> {
  const filePath = file.path;
  const cancelled = { filePath, reminders: [], lineCount: 0 };
  if (signal?.aborted) return cancelled;

  try {
    const originalContent = await app.vault.read(file);
    if (signal?.aborted) return cancelled;
    const deferred = (): FileScanResult => ({
      filePath,
      ...scanReminderMarkdownContent(filePath, originalContent, remindersFolderPath, { skipUnresolvedSchedules: true }),
      deferred: true,
    });
    const ownership = identityOwners ? await resolveReminderIdentityOwners(app, filePath, originalContent, identityOwners) : undefined;
    if (signal?.aborted) return cancelled;
    if (shouldDeferNormalization()) return deferred();
    const currentReservedIds = new Set([...reservedIds, ...(ownership?.reservedIds ?? [])]);
    if (currentReservedIds.size && shouldDeferCollisionRepair()) return deferred();
    if (ownership && !ownership.isCurrent()) return deferred();
    let normalized = normalizeReminderIds(originalContent, currentReservedIds);
    if (normalized.remindersUpdated > 0) {
      let remindersUpdated = 0;
      let targetChanged = false;
      const content = await app.vault.process(file, (currentContent) => {
        // Ownership was verified for the identifiers in the original bytes.
        // Retry with new evidence if a concurrent edit changes the target.
        if (ownership && currentContent !== originalContent) {
          targetChanged = true;
          return currentContent;
        }
        if (signal?.aborted || shouldDeferNormalization() || currentReservedIds.size && shouldDeferCollisionRepair()
          || ownership && !ownership.isCurrent()) return currentContent;
        const currentNormalization = normalizeReminderIds(currentContent, currentReservedIds);
        remindersUpdated = currentNormalization.remindersUpdated;
        return currentNormalization.content;
      });
      if (targetChanged) return deferred();
      normalized = { content, remindersUpdated };
      if (remindersUpdated > 0) {
        log.info(` Added ${remindersUpdated} reminder identifiers to ${filePath}`);
      }
    }
    if (signal?.aborted) return cancelled;
    if (shouldDeferNormalization() || currentReservedIds.size && shouldDeferCollisionRepair()
      || ownership && !ownership.isCurrent()) return deferred();
    const result = scanReminderMarkdownContent(filePath, normalized.content, remindersFolderPath);

    return {
      filePath,
      reminders: result.reminders,
      lineCount: result.lineCount,
      ...(ownership?.releasedOwners.length ? { releasedOwners: ownership.releasedOwners } : {}),
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
  shouldDeferNormalization = () => false,
  shouldDeferCollisionRepair = () => false,
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
  const identityOwners: ReminderIdentityOwners = new Map();
  let deferred = false;
  for (const file of reminderFiles) {
    if (signal?.aborted) break;
    if (shouldDeferNormalization()) { deferred = true; break; }
    const result = await scanFile(app, file, remindersFolderPath, new Set(), signal, identityOwners, shouldDeferNormalization, shouldDeferCollisionRepair);
    if (result.deferred) deferred = true;
    if (result.error) continue;
    for (const released of result.releasedOwners ?? []) {
      const stale = allReminders.findIndex(reminder => reminder.id === released.id && reminder.filePath === released.filePath);
      if (stale !== -1) allReminders.splice(stale, 1);
      identityOwners.get(released.id)?.delete(released.filePath);
    }
    allReminders.push(...result.reminders);
    totalLines += result.lineCount;
    addReminderIdentityOwners(identityOwners, result.reminders);
  }

  const scanDurationMs = Date.now() - startTime;

  log.info(
    ` Scanned ${reminderFiles.length} files, found ${allReminders.length} reminders in ${scanDurationMs}ms`
  );
  const identityCounts = new Map<string, number>();
  if (deferred) for (const reminder of allReminders) identityCounts.set(reminder.id, (identityCounts.get(reminder.id) ?? 0) + 1);

  return {
    // Keep healthy persisted reminders visible while collision repair waits
    // for sync. Neither ambiguous owner is exposed as an editable identity.
    reminders: deferred ? allReminders.filter(reminder => identityCounts.get(reminder.id) === 1) : allReminders,
    filesScanned: reminderFiles.length,
    totalLines,
    scanDurationMs,
    discoveredProjects: Array.from(discoveredProjects).sort(),
    ...(deferred ? { deferred: true } : {}),
    ...(deferred ? { ambiguousOwners: allReminders.filter(reminder => (identityCounts.get(reminder.id) ?? 0) > 1)
      .map(({ id, filePath }) => ({ id, filePath })) } : {}),
  };
}
