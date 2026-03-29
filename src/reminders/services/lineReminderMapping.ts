/**
 * Line Reminder Mapping Service
 *
 * Maintains bidirectional mapping between markdown checkbox lines and reminders in storage.
 * Enables sync between markdown content and JSONStorage.
 */

import type { Reminder } from '@/reminders';
import { generateContentHash } from '@/reminders/utils/checkboxParser';

interface LineMappingEntry {
  reminderId: string;
  lineNumber: number;
  contentHash: string;
  lastSeen: number;
}

interface FileMapping {
  [lineNumber: number]: LineMappingEntry;
}

function getFileMappingEntries(fileMapping: FileMapping): Array<readonly [number, LineMappingEntry]> {
  const entries: Array<readonly [number, LineMappingEntry]> = [];
  for (const key of Object.keys(fileMapping)) {
    const lineNumber = Number.parseInt(key, 10);
    const entry = fileMapping[lineNumber];
    if (!Number.isNaN(lineNumber) && entry !== undefined) {
      entries.push([lineNumber, entry] as const);
    }
  }
  return entries;
}

function getFileMappingValues(fileMapping: FileMapping): LineMappingEntry[] {
  return getFileMappingEntries(fileMapping).map(([, entry]) => entry);
}

/**
 * Service that tracks which markdown line corresponds to which reminder
 */
export class LineReminderMappingService {
  /** Map of filePath -> (lineNumber -> mapping entry) */
  private mappings: Map<string, FileMapping> = new Map();

  /** Reverse map: reminderId -> { filePath, lineNumber } */
  private reverseMap: Map<string, { filePath: string; lineNumber: number }> = new Map();

  /**
   * Get the reminder ID for a specific line in a file
   */
  getReminderForLine(filePath: string, lineNumber: number): string | undefined {
    return this.mappings.get(filePath)?.[lineNumber]?.reminderId;
  }

  /**
   * Get the line number for a specific reminder
   */
  getLineForReminder(reminderId: string): { filePath: string; lineNumber: number } | undefined {
    return this.reverseMap.get(reminderId);
  }

  /**
   * Get all mappings for a file
   */
  getFileMappings(filePath: string): FileMapping | undefined {
    return this.mappings.get(filePath);
  }

  /**
   * Register a mapping between a line and a reminder
   */
  registerLine(
    filePath: string,
    lineNumber: number,
    reminderId: string,
    content: string
  ): void {
    // Ensure file mapping exists
    if (!this.mappings.has(filePath)) {
      this.mappings.set(filePath, {});
    }

    const fileMapping = this.mappings.get(filePath)!;

    // Remove old mapping if this reminder was previously at a different line
    const oldLocation = this.reverseMap.get(reminderId);
    if (oldLocation && (oldLocation.filePath !== filePath || oldLocation.lineNumber !== lineNumber)) {
      delete this.mappings.get(oldLocation.filePath)?.[oldLocation.lineNumber];
    }

    // Create new mapping
    fileMapping[lineNumber] = {
      reminderId,
      lineNumber,
      contentHash: generateContentHash(content),
      lastSeen: Date.now(),
    };

    // Update reverse map
    this.reverseMap.set(reminderId, { filePath, lineNumber });
  }

  /**
   * Remove a line mapping
   */
  unregisterLine(filePath: string, lineNumber: number): string | undefined {
    const fileMapping = this.mappings.get(filePath);
    if (!fileMapping) return undefined;

    const entry = fileMapping[lineNumber];
    if (!entry) return undefined;

    // Remove from reverse map
    this.reverseMap.delete(entry.reminderId);

    // Remove from file mapping
    delete fileMapping[lineNumber];

    return entry.reminderId;
  }

  /**
   * Remove all mappings for a reminder
   */
  unregisterReminder(reminderId: string): void {
    const location = this.reverseMap.get(reminderId);
    if (location) {
      delete this.mappings.get(location.filePath)?.[location.lineNumber];
      this.reverseMap.delete(reminderId);
    }
  }

  /**
   * Update line numbers when lines are inserted/deleted
   * Call this when document changes affect line positions
   */
  shiftLines(filePath: string, fromLine: number, delta: number): void {
    const fileMapping = this.mappings.get(filePath);
    if (!fileMapping) return;

    const newMapping: FileMapping = {};
    const affectedReminders: Array<{ reminderId: string; newLine: number }> = [];

    for (const [lineNum, entry] of getFileMappingEntries(fileMapping)) {
      if (lineNum >= fromLine) {
        // Line needs to shift
        const newLineNum = lineNum + delta;
        if (newLineNum >= 0) {
          newMapping[newLineNum] = {
            ...entry,
            lineNumber: newLineNum,
          };
          affectedReminders.push({ reminderId: entry.reminderId, newLine: newLineNum });
        } else {
          // Line shifted before start of file - remove reverse mapping
          this.reverseMap.delete(entry.reminderId);
        }
      } else {
        // Line stays at same position
        newMapping[lineNum] = entry;
      }
    }

    this.mappings.set(filePath, newMapping);

    // Update reverse map
    for (const { reminderId, newLine } of affectedReminders) {
      this.reverseMap.set(reminderId, { filePath, lineNumber: newLine });
    }
  }

  /**
   * Clear all mappings for a file
   */
  clearFile(filePath: string): void {
    const fileMapping = this.mappings.get(filePath);
    if (fileMapping) {
      // Remove from reverse map
      for (const entry of getFileMappingValues(fileMapping)) {
        this.reverseMap.delete(entry.reminderId);
      }
      this.mappings.delete(filePath);
    }
  }

  /**
   * Clear all mappings
   */
  clearAll(): void {
    this.mappings.clear();
    this.reverseMap.clear();
  }

  /**
   * Reconcile mappings with actual reminders from storage
   * Call this when a file is opened to sync state
   *
   * @param filePath - File path
   * @param reminders - Reminders from storage that have fileLink matching this file
   * @param checkboxLines - Array of { lineNumber, content } from the document
   */
  reconcile(
    filePath: string,
    reminders: Reminder[],
    checkboxLines: Array<{ lineNumber: number; content: string }>
  ): {
    matched: Array<{ lineNumber: number; reminder: Reminder }>;
    orphaned: Reminder[];
    unmapped: Array<{ lineNumber: number; content: string }>;
  } {
    // Clear existing mappings for this file
    this.clearFile(filePath);

    const matched: Array<{ lineNumber: number; reminder: Reminder }> = [];
    const orphaned: Reminder[] = [];
    const unmapped: Array<{ lineNumber: number; content: string }> = [];

    // Create hash map of checkbox lines for matching
    const linesByHash = new Map<string, Array<{ lineNumber: number; content: string }>>();
    for (const line of checkboxLines) {
      const hash = generateContentHash(line.content);
      if (!linesByHash.has(hash)) {
        linesByHash.set(hash, []);
      }
      linesByHash.get(hash)!.push(line);
    }

    // Track which lines have been matched
    const matchedLineNumbers = new Set<number>();

    // Try to match each reminder to a line
    for (const reminder of reminders) {
      const hash = generateContentHash(reminder.content);
      const candidates = linesByHash.get(hash);

      if (candidates && candidates.length > 0) {
        // Find first unmatched candidate
        const candidate = candidates.find(c => !matchedLineNumbers.has(c.lineNumber));

        if (candidate) {
          // Match found
          matchedLineNumbers.add(candidate.lineNumber);
          this.registerLine(filePath, candidate.lineNumber, reminder.id, candidate.content);
          matched.push({ lineNumber: candidate.lineNumber, reminder });
        } else {
          // All candidates already matched to other reminders
          orphaned.push(reminder);
        }
      } else {
        // No matching line found
        orphaned.push(reminder);
      }
    }

    // Find unmapped checkbox lines (new todos)
    for (const line of checkboxLines) {
      if (!matchedLineNumbers.has(line.lineNumber)) {
        unmapped.push(line);
      }
    }

    return { matched, orphaned, unmapped };
  }

  /**
   * Find a reminder by content hash (for detecting moved lines)
   */
  findByContentHash(filePath: string, contentHash: string): LineMappingEntry | undefined {
    const fileMapping = this.mappings.get(filePath);
    if (!fileMapping) return undefined;

    for (const entry of getFileMappingValues(fileMapping)) {
      if (entry.contentHash === contentHash) {
        return entry;
      }
    }
    return undefined;
  }
}

// Singleton instance
let instance: LineReminderMappingService | null = null;

export function getLineReminderMappingService(): LineReminderMappingService {
  if (!instance) {
    instance = new LineReminderMappingService();
  }
  return instance;
}
