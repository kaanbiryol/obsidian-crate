import { parseQuery, type ReminderQueryOptions } from "./queryOptions";

export type RemindersBlockType = "reminders" | "reminders-today" | "reminders-upcoming";

type RemindersBlockInfo = {
	content: string;
	type: RemindersBlockType;
};

export function parseRemindersBlockOptions(blockInfo: RemindersBlockInfo): ReminderQueryOptions {
	const parsed = parseQuery(blockInfo.content);

	if (blockInfo.type === "reminders-today") {
		return {
			...parsed,
			showToday: true,
		};
	}

	if (blockInfo.type === "reminders-upcoming") {
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
