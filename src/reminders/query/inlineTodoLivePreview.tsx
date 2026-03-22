/**
 * Inline Todo Live Preview
 *
 * CodeMirror 6 extension that transforms markdown checkboxes into styled reminder widgets.
 * Provides bidirectional sync between markdown content and JSONStorage.
 */

import { editorViewField, setIcon, type TFile } from "obsidian";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { format, isToday, isTomorrow } from "date-fns";
import * as chrono from "chrono-node";
import { findAllMatches, createLogger } from "@/reminders";

const log = createLogger('InlineTodo');

import type CratePlugin from "@/main";
import type { Reminder } from "@/reminders/types/plugin-reminder";
import { openReminderEditModal } from "@/reminders/ui/modals";
import {
  parseCheckboxLine,
  isCheckboxLine,
  rebuildCheckboxLine,
} from "@/reminders/utils/checkboxParser";
import {
  getLineReminderMappingService,
  type LineReminderMappingService,
} from "@/reminders/services/lineReminderMapping";
import { isInRemindersFolder } from "@/reminders/data/vaultScanner";

/**
 * Check if the date text represents a recurrence pattern
 */
function isRecurrenceText(text: string): boolean {
  const recurrencePatterns = /^(every|daily|weekly|monthly|yearly)\b/i;
  return recurrencePatterns.test(text.trim());
}

/**
 * Get the CSS color for a HeroUI variant
 */
function getVariantColors(variant: string): { bg: string; text: string } {
  const variantMap: Record<string, { bg: string; text: string }> = {
    primary: { bg: "hsl(var(--heroui-primary) / 0.15)", text: "hsl(var(--heroui-primary) / 1)" },
    secondary: { bg: "hsl(var(--heroui-secondary) / 0.15)", text: "hsl(var(--heroui-secondary) / 1)" },
    success: { bg: "hsl(var(--heroui-success) / 0.15)", text: "hsl(var(--heroui-success) / 1)" },
    warning: { bg: "hsl(var(--heroui-warning) / 0.15)", text: "hsl(var(--heroui-warning) / 1)" },
    danger: { bg: "hsl(var(--heroui-danger) / 0.15)", text: "hsl(var(--heroui-danger) / 1)" },
  };
  return variantMap[variant] || variantMap.primary;
}

/**
 * Widget that renders a single inline chip (replacing marker text)
 * Used when cursor is NOT on the line to show clean formatted view
 * Clicking a chip opens the edit reminder modal
 */
class InlineChipWidget extends WidgetType {
  private readonly type: "date" | "priority";
  private readonly text: string;
  private readonly displayText: string;
  private readonly plugin: CratePlugin;
  private readonly filePath: string;
  private readonly lineNum: number;
  private readonly mappingService: LineReminderMappingService;
  private readonly isCompleted: boolean;
  private readonly view: EditorView;
  private readonly lineFrom: number;
  private readonly lineTo: number;

  constructor(
    type: "date" | "priority",
    text: string,
    displayText: string,
    plugin: CratePlugin,
    filePath: string,
    lineNum: number,
    mappingService: LineReminderMappingService,
    isCompleted: boolean,
    view: EditorView,
    lineFrom: number,
    lineTo: number
  ) {
    super();
    this.type = type;
    this.text = text;
    this.displayText = displayText;
    this.plugin = plugin;
    this.filePath = filePath;
    this.lineNum = lineNum;
    this.mappingService = mappingService;
    this.isCompleted = isCompleted;
    this.view = view;
    this.lineFrom = lineFrom;
    this.lineTo = lineTo;
  }

  eq(other: InlineChipWidget): boolean {
    return (
      this.type === other.type &&
      this.text === other.text &&
      this.lineNum === other.lineNum &&
      this.isCompleted === other.isCompleted &&
      this.lineFrom === other.lineFrom &&
      this.lineTo === other.lineTo
    );
  }

  toDOM(): HTMLElement {
    const chip = document.createElement("span");

    // Base chip styles
    const completedStyles = this.isCompleted ? `
      opacity: 0.5;
    ` : "";

    const baseStyles = `
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 12px;
      font-size: var(--reminder-font-sm);
      font-weight: var(--reminder-font-weight-medium);
      margin-left: 8px;
      margin-right: 2px;
      vertical-align: baseline;
      cursor: pointer;
      ${completedStyles}
    `;

    // Create icon element
    const iconSpan = document.createElement("span");
    iconSpan.style.cssText = "display: inline-flex; align-items: center; width: 12px; height: 12px;";

    // Create text element
    const textSpan = document.createElement("span");

    if (this.type === "date") {
      const colors = getVariantColors("success");
      chip.style.cssText = baseStyles + `
        background-color: ${colors.bg};
        color: ${colors.text};
      `;
      // Use repeat icon for recurrence patterns, calendar for regular dates
      setIcon(iconSpan, isRecurrenceText(this.text) ? "repeat" : "calendar");
      textSpan.textContent = this.displayText;
      chip.appendChild(iconSpan);
      chip.appendChild(textSpan);
    } else if (this.type === "priority") {
      const colors = getVariantColors("danger");
      chip.style.cssText = baseStyles + `
        background-color: ${colors.bg};
        color: ${colors.text};
        padding: 5px 8px;
      `;
      // Use icon like other chips for consistent alignment
      const priorityIconSpan = document.createElement("span");
      priorityIconSpan.style.cssText = "display: inline-flex; align-items: center; width: 14px; height: 14px;";
      setIcon(priorityIconSpan, "flag");
      // Fill the icon by targeting the SVG
      const svg = priorityIconSpan.querySelector("svg");
      if (svg) {
        svg.style.fill = "currentColor";
      }
      chip.appendChild(priorityIconSpan);
    }

    // Use mousedown to prevent text selection and open modal
    chip.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.openEditModal();
    });

    return chip;
  }

  private async openEditModal() {
    // Look up the reminder for this line
    const reminderId = this.mappingService.getReminderForLine(this.filePath, this.lineNum);
    if (!reminderId) return;

    const reminder = await this.plugin.storage.getByIdAsync(reminderId);
    if (!reminder) return;

    openReminderEditModal(this.plugin, reminder, (action, updatedReminder) => {
      if (action === 'saved' && updatedReminder) {
        this.updateMarkdownLine(updatedReminder);
      } else if (action === 'deleted') {
        this.deleteMarkdownLine();
      }
    });
  }

  private updateMarkdownLine(updated: Reminder) {
    setTimeout(() => {
      const doc = this.view.state.doc;
      if (this.lineFrom >= doc.length || this.lineTo > doc.length) {
        return;
      }

      const dueDate = updated.dueDatetime
        ? new Date(updated.dueDatetime)
        : updated.dueDate
          ? new Date(updated.dueDate)
          : undefined;

      const newLine = rebuildCheckboxLine(
        "",
        updated.completed,
        updated.content,
        dueDate,
        updated.priority
      );

      const lineText = doc.sliceString(this.lineFrom, this.lineTo);
      const indentMatch = lineText.match(/^(\s*)/);
      const indent = indentMatch ? indentMatch[1] : "";

      this.view.dispatch({
        changes: {
          from: this.lineFrom,
          to: this.lineTo,
          insert: indent + newLine.trimStart(),
        },
      });
    }, 50);
  }

  private deleteMarkdownLine() {
    setTimeout(() => {
      const doc = this.view.state.doc;
      if (this.lineFrom >= doc.length) {
        return;
      }

      const line = doc.lineAt(this.lineFrom);
      let deleteFrom = line.from;
      let deleteTo = line.to;

      if (line.number < doc.lines) {
        deleteTo = doc.line(line.number + 1).from;
      } else if (line.number > 1) {
        deleteFrom = doc.line(line.number - 1).to;
      }

      this.view.dispatch({
        changes: { from: deleteFrom, to: deleteTo, insert: "" },
      });

      this.mappingService.unregisterLine(this.filePath, line.number);
    }, 50);
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Check if a position is inside a code block
 */
function isInsideCodeBlock(view: EditorView, pos: number): boolean {
  let insideCodeBlock = false;

  syntaxTree(view.state).iterate({
    from: 0,
    to: pos + 1,
    enter: (node) => {
      if (
        node.name === "FencedCode" ||
        node.name === "CodeBlock" ||
        node.name.includes("codeblock")
      ) {
        if (pos >= node.from && pos <= node.to) {
          insideCodeBlock = true;
        }
      }
    },
  });

  return insideCodeBlock;
}

/**
 * Create the inline todo CodeMirror extension
 */
export function createInlineTodoExtension(plugin: CratePlugin) {
  const mappingService = getLineReminderMappingService();

  // Cache for reminders by file
  const reminderCache = new Map<string, Map<string, Reminder>>();

  // Track files currently being reconciled (to avoid race conditions)
  const reconcilingFiles = new Set<string>();

  // Debounce timer for doc changes (create/delete detection)
  let createDebounce: ReturnType<typeof setTimeout> | null = null;


  /**
   * Format a date match text into a display-friendly format
   */
  function formatDateChipText(dateText: string): string {
    // Try to parse the date and format it nicely
    const parsed = chrono.parseDate(dateText);

    if (!parsed) return dateText;

    if (isToday(parsed)) {
      const hasTime = parsed.getHours() !== 0 || parsed.getMinutes() !== 0;
      return hasTime ? format(parsed, "'Today' HH:mm") : "Today";
    }
    if (isTomorrow(parsed)) {
      const hasTime = parsed.getHours() !== 0 || parsed.getMinutes() !== 0;
      return hasTime ? format(parsed, "'Tomorrow' HH:mm") : "Tomorrow";
    }

    const hasTime = parsed.getHours() !== 0 || parsed.getMinutes() !== 0;
    return hasTime ? format(parsed, "MMM d HH:mm") : format(parsed, "MMM d");
  }

  /**
   * Build decorations for visible checkbox lines
   * - When cursor is ON the line: show raw text (no decorations) for editing
   * - When cursor is NOT on the line: replace markers with chip widgets
   */
  function buildDecorations(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const cursorPos = view.state.selection.main.head;
    const file = view.state.field(editorViewField)?.file;
    const filePath = file?.path;

    if (!filePath) {
      return builder.finish();
    }

    // Only render inline todo decorations for files in the reminders folder
    const remindersFolderPath = plugin.remindersSettings.remindersFolderPath;
    if (!isInRemindersFolder(filePath, remindersFolderPath)) {
      return builder.finish();
    }

    const doc = view.state.doc;

    // Collect all decorations first (must be sorted by position)
    const decorations: Array<{ from: number; to: number; deco: Decoration }> = [];

    // Iterate through visible lines
    for (const { from, to } of view.visibleRanges) {
      const startLine = doc.lineAt(from).number;
      const endLine = doc.lineAt(to).number;

      for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
        const line = doc.line(lineNum);

        // Skip if not a checkbox line
        if (!isCheckboxLine(line.text)) {
          continue;
        }

        // Skip if inside a code block
        if (isInsideCodeBlock(view, line.from)) {
          continue;
        }

        const cursorOnLine = cursorPos >= line.from && cursorPos <= line.to;

        // When cursor is on line, show raw text for editing (no decorations)
        if (cursorOnLine) {
          continue;
        }

        // DISPLAY MODE: Replace markers with chip widgets
        const checkboxMatch = line.text.match(/^(\s*-\s*\[[ xX]\]\s*)/);
        if (!checkboxMatch) continue;

        // Check if checkbox is completed (has x or X)
        const isCompleted = /\[[xX]\]/.test(checkboxMatch[0]);

        const contentStart = checkboxMatch[0].length;
        const content = line.text.slice(contentStart);

        // Find all date/project/priority matches in the content
        const matches = findAllMatches(content);

        for (const match of matches) {
          // Skip project/tag matches - let Obsidian render them normally
          if (match.type === "project") {
            continue;
          }

          // Include leading space in the replacement to avoid strikethrough on spaces
          let leadingSpaces = 0;
          const matchStart = match.index;
          if (matchStart > 0 && content[matchStart - 1] === ' ') {
            leadingSpaces = 1;
            // Check for multiple spaces
            let i = matchStart - 2;
            while (i >= 0 && content[i] === ' ') {
              leadingSpaces++;
              i--;
            }
          }

          const from = line.from + contentStart + match.index - leadingSpaces;
          const to = line.from + contentStart + match.index + match.length;

          let displayText = match.text;
          if (match.type === "date") {
            // Don't format recurrence patterns - show them as-is
            if (!isRecurrenceText(match.text)) {
              displayText = formatDateChipText(match.text);
            }
          }

          const widget = new InlineChipWidget(
            match.type as "date" | "priority",
            match.text,
            displayText,
            plugin,
            filePath,
            lineNum,
            mappingService,
            isCompleted,
            view,
            line.from,
            line.to
          );

          const replaceDeco = Decoration.replace({
            widget,
          });

          decorations.push({ from, to, deco: replaceDeco });
        }
      }
    }

    // Sort decorations by position and add to builder
    decorations.sort((a, b) => a.from - b.from || a.to - b.to);
    for (const { from, to, deco } of decorations) {
      builder.add(from, to, deco);
    }

    return builder.finish();
  }

  /**
   * Reconcile reminders with markdown checkboxes when file opens
   */
  async function reconcileFile(view: EditorView, filePath: string) {
    // Skip reconciliation for files outside reminders folder
    const remindersFolderPath = plugin.remindersSettings.remindersFolderPath;
    if (!isInRemindersFolder(filePath, remindersFolderPath)) {
      return;
    }

    // Mark file as being reconciled (prevents races with queued updates)
    reconcilingFiles.add(filePath);

    try {
      // Get reminders for this file from storage
      const reminders = await plugin.storage.getByFile(filePath);

      // Build checkbox line list
      const checkboxLines: Array<{ lineNumber: number; content: string }> = [];
      const doc = view.state.doc;

      for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        if (isCheckboxLine(line.text)) {
          const parsed = parseCheckboxLine(line.text);
          if (parsed) {
            checkboxLines.push({
              lineNumber: i,
              content: parsed.rawContent,
            });
          }
        }
      }

      // Reconcile mappings
      const result = mappingService.reconcile(filePath, reminders, checkboxLines);

      log.info(`Reconciliation for ${filePath}:`, {
        remindersFromStorage: reminders.length,
        checkboxLines: checkboxLines.length,
        matched: result.matched.length,
        orphaned: result.orphaned.length,
        unmapped: result.unmapped.length,
      });

      // Debug: log matched reminders
      for (const { lineNumber, reminder } of result.matched) {
        log.info(`Matched line ${lineNumber} to reminder:`, {
          id: reminder.id,
          content: reminder.content,
          project: reminder.project,
        });
      }

      // Update cache
      const fileCache = new Map<string, Reminder>();
      for (const { reminder } of result.matched) {
        fileCache.set(reminder.id, reminder);
      }
      reminderCache.set(filePath, fileCache);

      // Handle unmapped lines (new checkboxes) in a single batch
      if (result.unmapped.length > 0) {
        log.info(`Processing ${result.unmapped.length} unmapped lines in batch`);

        // Rescan file ONCE to get all indexed reminders
        const file = plugin.app.vault.getAbstractFileByPath(filePath);
        if (file && 'extension' in file) {
          await plugin.reminderIndex.rescanFile(file as TFile, true); // Force rescan
        }

        // Get all indexed reminders after rescan
        const indexedReminders = plugin.reminderIndex.getByFile(filePath);
        const indexedByContent = new Map<string, typeof indexedReminders[0]>();
        for (const r of indexedReminders) {
          indexedByContent.set(r.content, r);
        }

        // Match unmapped lines to indexed reminders
        let fileCache = reminderCache.get(filePath);
        if (!fileCache) {
          fileCache = new Map();
          reminderCache.set(filePath, fileCache);
        }

        for (const { lineNumber, content } of result.unmapped) {
          const parsed = parseCheckboxLine(`- [ ] ${content}`);
          if (!parsed || !parsed.parsed.cleanContent.trim()) continue;

          const cleanContent = parsed.parsed.cleanContent;
          const indexedReminder = indexedByContent.get(cleanContent);

          if (indexedReminder) {
            // Convert indexed reminder to Reminder type
            const reminder: Reminder = {
              id: indexedReminder.id,
              content: indexedReminder.content,
              dueDate: indexedReminder.dueDate,
              dueDatetime: indexedReminder.dueDatetime,
              priority: indexedReminder.priority,
              completed: indexedReminder.completed,
              project: indexedReminder.project,
              fileLink: indexedReminder.filePath,
              recurrence: indexedReminder.recurrence,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };

            // Register mapping and update cache
            mappingService.registerLine(filePath, lineNumber, reminder.id, content);
            fileCache.set(reminder.id, reminder);
            log.info(`Matched unmapped line ${lineNumber} to indexed reminder ${reminder.id}`);
          } else {
            log.warn(`Could not find indexed reminder for line ${lineNumber} with content: ${cleanContent.substring(0, 50)}`);
          }
        }
      }
    } catch (error) {
      log.error("Failed to reconcile file:", error);
    } finally {
      // Mark reconciliation as complete
      reconcilingFiles.delete(filePath);
    }
  }

  /**
   * Check if reminder properties differ from parsed line
   */
  function hasReminderChanged(
    reminder: Reminder,
    parsed: NonNullable<ReturnType<typeof parseCheckboxLine>>
  ): boolean {
    // Check completed state
    if (reminder.completed !== parsed.isCompleted) return true;

    // Check priority
    if (reminder.priority !== parsed.parsed.priority) return true;

    // Check project - only compare if the line has an explicit #tag
    // If no tag in the line, the project is derived from file path and shouldn't trigger update
    if (parsed.parsed.project && reminder.project !== parsed.parsed.project) return true;

    // Check date (simplified comparison)
    const reminderDate = reminder.dueDatetime || reminder.dueDate;
    const parsedDate = parsed.parsed.dueDate;

    if (!reminderDate && !parsedDate) return false;
    if (!reminderDate || !parsedDate) return true;

    // Compare dates (rough comparison)
    const reminderDateObj = new Date(reminderDate);
    return Math.abs(reminderDateObj.getTime() - parsedDate.getTime()) > 60000; // 1 minute tolerance
  }

  /**
   * Update a reminder when its markdown line content changes
   */
  async function updateReminderFromLine(
    reminderId: string,
    parsed: NonNullable<ReturnType<typeof parseCheckboxLine>>,
    filePath: string
  ) {
    // Convert parsed date to storage format
    let dueDate: string | undefined;
    let dueDatetime: string | undefined;

    if (parsed.parsed.dueDate) {
      const date = parsed.parsed.dueDate;
      const hasTime = date.getHours() !== 0 || date.getMinutes() !== 0;

      if (hasTime) {
        dueDatetime = date.toISOString();
      } else {
        dueDate = date.toISOString().split("T")[0];
      }
    }

    // Check if this is a project change - we'll need to clean up the cache after
    const existingReminder = reminderCache.get(filePath)?.get(reminderId);
    const oldProject = existingReminder?.project;
    const newProject = parsed.parsed.project;
    const projectChanged = newProject && oldProject && newProject !== oldProject;

    try {
      const updated = await plugin.storage.update(reminderId, {
        content: parsed.parsed.cleanContent,
        dueDate,
        dueDatetime,
        priority: parsed.parsed.priority,
        project: parsed.parsed.project || undefined,
        completed: parsed.isCompleted,
      });

      if (projectChanged) {
        // Reminder was moved to a different file - remove from current cache and mapping
        log.info(`Reminder ${reminderId} moved to project ${newProject}, cleaning up cache`);
        reminderCache.get(filePath)?.delete(reminderId);
        mappingService.unregisterReminder(reminderId);
      } else if (updated) {
        // Update cache normally
        reminderCache.get(filePath)?.set(reminderId, updated);
        log.info(`Updated reminder ${reminderId}`);
      }
    } catch (error) {
      log.error("Failed to update reminder:", error);
    }
  }

  /**
   * Process a single line when cursor leaves it
   * Creates new reminder or updates existing one, and normalizes the line
   *
   * NOTE: Uses content-based matching primarily to avoid issues with stale
   * line number mappings after line insertions/deletions.
   */
  async function processLineOnLeave(view: EditorView, filePath: string, lineNum: number) {
    const doc = view.state.doc;
    if (lineNum < 1 || lineNum > doc.lines) return;

    const line = doc.line(lineNum);
    if (!isCheckboxLine(line.text)) return;

    const parsed = parseCheckboxLine(line.text);
    if (!parsed || !parsed.parsed.cleanContent.trim()) return;

    const fileCache = reminderCache.get(filePath);

    // FIRST: Try content-based matching (more reliable after line shifts)
    if (fileCache) {
      for (const reminder of fileCache.values()) {
        if (reminder.content === parsed.parsed.cleanContent) {
          // Found by content - update mapping and check for real changes
          mappingService.registerLine(filePath, lineNum, reminder.id, line.text);
          if (hasReminderChanged(reminder, parsed)) {
            await updateReminderFromLine(reminder.id, parsed, filePath);
          }
          return;
        }
      }
    }

    // FALLBACK: Check line number mapping (may be stale, so be more conservative)
    const existingReminderId = mappingService.getReminderForLine(filePath, lineNum);
    if (existingReminderId && fileCache) {
      const existingReminder = fileCache.get(existingReminderId);
      if (existingReminder) {
        // Only update if content matches (to avoid updating wrong reminder after line shifts)
        // If content doesn't match, the mapping is stale - just update the mapping
        if (existingReminder.content === parsed.parsed.cleanContent) {
          if (hasReminderChanged(existingReminder, parsed)) {
            await updateReminderFromLine(existingReminderId, parsed, filePath);
          }
        }
        // Don't trigger updates for mismatched content - mapping will be fixed by reconciliation
        return;
      }
    }

    // No matching reminder found - let reconciliation deal with it
    // Don't create here to avoid duplicates
    return;
  }

  /**
   * Handle orphaned reminders when lines are deleted
   * Checks if any mapped reminders no longer have corresponding lines
   *
   * DISABLED: This was causing cascading deletions across files when combined
   * with the project tag bug. The reconciliation on file open handles orphans
   * properly via the mapping service. When a line is actually deleted by the
   * user, the mapping service will detect it and clean up.
   */
  async function handleOrphanedReminders(_view: EditorView, _filePath: string) {
    // DISABLED - see comment above
    return;
  }

  // Create a ViewPlugin that manages the decorations and handles file reconciliation
  const viewPlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private filePath: string | undefined;
      private previousLineNum: number | null = null;

      constructor(view: EditorView) {
        const file = view.state.field(editorViewField)?.file;
        this.filePath = file?.path;
        this.decorations = buildDecorations(view);
        this.previousLineNum = view.state.doc.lineAt(view.state.selection.main.head).number;

        // Initial reconciliation
        if (this.filePath) {
          reconcileFile(view, this.filePath);
        }
      }

      update(update: ViewUpdate) {
        const file = update.view.state.field(editorViewField)?.file;
        const newFilePath = file?.path;

        // File changed - reconcile new file
        if (newFilePath !== this.filePath) {
          this.filePath = newFilePath;
          if (newFilePath) {
            reconcileFile(update.view, newFilePath);
          }
        }

        // When cursor moves to a different line AFTER editing, process the previous line
        // Only trigger on docChanged to avoid processing on simple selection/navigation
        if (update.docChanged && this.filePath) {
          const currentLineNum = update.state.doc.lineAt(
            update.state.selection.main.head
          ).number;

          // If cursor moved to a different line, process the previous line
          if (this.previousLineNum !== null && this.previousLineNum !== currentLineNum) {
            const prevLineNum = this.previousLineNum;
            const filePath = this.filePath;
            setTimeout(() => {
              processLineOnLeave(update.view, filePath, prevLineNum);
            }, 0);
          }

          this.previousLineNum = currentLineNum;
        }

        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = buildDecorations(update.view);

          // Handle line deletions (check if any mapped reminders are orphaned)
          if (update.docChanged && this.filePath) {
            if (createDebounce) {
              clearTimeout(createDebounce);
            }
            createDebounce = setTimeout(() => {
              handleOrphanedReminders(update.view, this.filePath!);
            }, 500);
          }
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );

  return viewPlugin;
}
