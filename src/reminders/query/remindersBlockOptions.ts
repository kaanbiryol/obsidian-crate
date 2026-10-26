export type RemindersBlockType = "reminders" | "reminders-today" | "reminders-upcoming";

type RemindersBlockInfo = {
	content: string;
	type: RemindersBlockType;
};

type ReminderQueryOptions = {
	projectFilter?: string;
	showCompleted: boolean;
	showToday: boolean;
	showUpcoming: boolean;
};

/** Block lines set a project filter and the show-completed flag; the block type picks the view. */
export function parseRemindersBlockOptions(blockInfo: RemindersBlockInfo): ReminderQueryOptions {
	const options: ReminderQueryOptions = {
		showCompleted: false,
		showToday: blockInfo.type === "reminders-today",
		showUpcoming: blockInfo.type === "reminders-upcoming",
	};

	for (const rawLine of blockInfo.content.trim().split("\n")) {
		const line = rawLine.trim();
		const lower = line.toLowerCase();

		if (lower.startsWith("project:")) {
			const value = line.slice("project:".length).trim();
			if (value) {
				options.projectFilter = value;
			}
		} else if (lower.startsWith("show-completed:")) {
			const value = lower.slice("show-completed:".length).trim();
			if (value === "true" || value === "false") {
				options.showCompleted = value === "true";
			}
		}
	}

	return options;
}

const fenceOf = (line = "") => /^(?:`{3,}|~{3,})/.exec(line.trim())?.[0];

export function setRemindersBlockShowCompleted(blockText: string, newValue: boolean): string | null {
	const lines = blockText.split("\n");
	const openingIndex = lines.findIndex(fenceOf);
	const fence = fenceOf(lines[openingIndex]);
	if (!fence) {
		return null;
	}

	// The closing fence repeats the opening fence character at least as many times.
	const closingIndex = lines.findIndex((line, idx) => idx > openingIndex && line.trim().startsWith(fence));
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
