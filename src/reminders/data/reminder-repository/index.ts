import type { MarkdownWriter } from "../markdown-writer";
import type { ReminderIndex } from "../reminder-index";
import { createReminderRepositoryMutations } from "./mutations";
import { createReminderRepositoryQueries } from "./queries";
import type { ReminderRepository } from "./types";

export type { ReminderRepository } from "./types";

export function createReminderRepository(
  index: ReminderIndex,
  writer: MarkdownWriter
): ReminderRepository {
  const context = { index, writer };
  return {
    ...createReminderRepositoryQueries(context),
    ...createReminderRepositoryMutations(context),
  };
}
