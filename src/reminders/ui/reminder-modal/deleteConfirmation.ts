import type { Reminder } from "@/reminders/types/plugin-reminder";

const MAX_PREVIEW_LENGTH = 50;

export function buildDeleteConfirmationMessage(reminder?: Reminder): string {
  const content = reminder?.content || "";
  const preview = content.substring(0, MAX_PREVIEW_LENGTH);
  const suffix = content.length > MAX_PREVIEW_LENGTH ? "..." : "";
  return `Delete "${preview}${suffix}"? This can't be undone.`;
}
