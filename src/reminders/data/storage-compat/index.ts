import type { MarkdownWriter } from "../markdown-writer";
import type { ReminderIndex } from "../reminder-index";
import { createStorageCompatMutations } from "./mutations";
import { createStorageCompatQueries } from "./queries";
import type { StorageCompat } from "./types";

export type { StorageCompat } from "./types";

/**
 * Create a storage compatibility layer
 */
export function createStorageCompat(
  index: ReminderIndex,
  writer: MarkdownWriter
): StorageCompat {
  const context = { index, writer };
  return {
    ...createStorageCompatQueries(context),
    ...createStorageCompatMutations(context),
  };
}
