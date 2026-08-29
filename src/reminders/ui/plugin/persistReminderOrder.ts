import { Notice } from "obsidian";
import { errorMessage } from "@/plugin/logger";
import type { ReminderRepository } from "@/reminders/data/reminder-repository";

export async function persistReminderOrder(
  repository: Pick<ReminderRepository, "reorder">,
  project: string,
  orderedIds: string[],
  restoreOrder: () => void,
): Promise<void> {
  try {
    await repository.reorder(project, orderedIds);
  } catch (error) {
    restoreOrder();
    new Notice(`Unable to reorder reminders: ${errorMessage(error)}`);
  }
}
