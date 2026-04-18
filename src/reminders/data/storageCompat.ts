import type { MarkdownWriter } from "./markdownWriter";
import type { ReminderIndex } from "./reminderIndex";
import { createStorageCompatMutations } from "./storageCompatMutations";
import { createStorageCompatQueries } from "./storageCompatQueries";
import type { StorageCompat } from "./storageCompatTypes";

export type { StorageCompat } from "./storageCompatTypes";

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
