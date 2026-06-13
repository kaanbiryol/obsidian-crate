import { parseQuery, type ReminderQueryOptions } from "./queryOptions";

const REMINDERS_BLOCK_TYPES = [
  "reminders",
  "reminders-today",
  "reminders-upcoming",
] as const;

type RemindersBlockType = (typeof REMINDERS_BLOCK_TYPES)[number];

export type RemindersBlockInfo = {
  content: string;
  type: RemindersBlockType;
  isToday: boolean;
  isUpcoming: boolean;
};

function isRemindersBlockType(type: string): type is RemindersBlockType {
  return (REMINDERS_BLOCK_TYPES as readonly string[]).includes(type);
}

export function isRemindersBlockStart(text: string): boolean {
  const firstLine = text.split("\n", 1)[0]?.trim() ?? "";
  if (!firstLine.startsWith("```")) {
    return false;
  }

  return isRemindersBlockType(firstLine.slice(3).trim().toLowerCase());
}

export function extractRemindersBlockInfo(blockText: string): RemindersBlockInfo | null {
  const lines = blockText.split("\n");
  if (lines.length < 2) {
    return null;
  }

  const opening = lines[0].trim();
  if (!opening.startsWith("```")) {
    return null;
  }

  const type = opening.slice(3).trim().toLowerCase();
  if (!isRemindersBlockType(type)) {
    return null;
  }

  const closingIndex = lines.findIndex((line, idx) => idx !== 0 && line.trim().startsWith("```"));
  const contentLines = closingIndex === -1 ? lines.slice(1) : lines.slice(1, closingIndex);

  return {
    content: contentLines.join("\n"),
    type,
    isToday: type === "reminders-today",
    isUpcoming: type === "reminders-upcoming",
  };
}

export function parseRemindersBlockOptions(blockInfo: RemindersBlockInfo): ReminderQueryOptions {
  const parsed = parseQuery(blockInfo.content);

  if (blockInfo.isToday) {
    return {
      ...parsed,
      showToday: true,
      projectFilter: undefined,
    };
  }

  if (blockInfo.isUpcoming) {
    return {
      ...parsed,
      showUpcoming: true,
    };
  }

  return parsed;
}

export function setRemindersBlockShowCompleted(blockText: string, newValue: boolean): string | null {
  const lines = blockText.split("\n");
  const openingIndex = lines.findIndex((line) => line.trim().startsWith("```"));
  if (openingIndex === -1) {
    return null;
  }

  const closingIndex = lines.findIndex((line, idx) => idx > openingIndex && line.trim().startsWith("```"));
  if (closingIndex === -1) {
    return null;
  }

  const contentLines = lines.slice(openingIndex + 1, closingIndex);
  const existingLine = contentLines.find((line) => line.trim().startsWith("show-completed:"));
  const indentation = existingLine?.match(/^\s*/)?.[0] ?? "";
  const filteredLines = contentLines.filter((line) => !line.trim().startsWith("show-completed:"));

  return [
    ...lines.slice(0, openingIndex + 1),
    ...filteredLines,
    `${indentation}show-completed: ${newValue}`,
    ...lines.slice(closingIndex),
  ].join("\n");
}
