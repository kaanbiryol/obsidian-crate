import { createReminderId, setReminderIdMarker } from './reminderIdentity';
import { parseCheckboxLine, type ParsedCheckbox } from './grammar/checkboxParser';
import { UnresolvedReminderScheduleError } from './grammar/reminderParser';
import { normalizeReminderScheduleLine } from './normalizeReminderSchedule';
import { markdownTaskContexts } from './markdownTaskContext';

interface ReminderIdNormalizationResult {
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
  parsePersisted: (line: string) => ParsedCheckbox | null = value => parseCheckboxLine(value, { persisted: true }),
): ReminderIdNormalizationResult {
  const lines = content.split("\n");
  const usedIds = new Set(reservedIds);
  let remindersUpdated = 0;

  for (const index of markdownTaskContexts(lines).keys()) {
    const line = lines[index];
    if (line === undefined) continue;
    // Saved lines resolve in persisted mode; only unresolved drafts need the
    // slower draft parse and schedule normalization.
    let parsed: ParsedCheckbox | null;
    let unresolved = false;
    try {
      parsed = parsePersisted(line);
    } catch (error) {
      if (!(error instanceof UnresolvedReminderScheduleError)) throw error;
      unresolved = true;
      parsed = parseCheckboxLine(line);
    }
    if (!parsed || !parsed.parsed.cleanContent.trim()) {
      continue;
    }

    const reminderId = parsed.reminderId && !usedIds.has(parsed.reminderId)
      ? parsed.reminderId : createUniqueReminderId(usedIds);
    usedIds.add(reminderId);
    const scheduled = unresolved ? normalizeReminderScheduleLine(line, () => { throw new UnresolvedReminderScheduleError(); }) : line;
    const normalized = setReminderIdMarker(scheduled, reminderId);
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
