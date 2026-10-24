import type { IndexedReminder } from "./index";
import type { ReminderLookupStore } from "./lookup-store";
import type { ReminderOptimisticState } from "./optimistic-state";
import type { FileScanResult } from "../vaultScanner";
import { addReminderIdentityOwners, releaseReminderIdentityOwners, type ReminderIdentityOwner, type ReminderIdentityOwners } from '../reminder-identity-owners';
import type { ReminderSourceIssue } from '../reminder-source-issues';

/** The index state a single-file scan updates. Collections are updated in place;
 * the reassigned arrays come back in the result. */
export interface FileScanState {
  reminders: IndexedReminder[];
  ambiguousOwners: ReminderIdentityOwner[];
  sourceIssues: Map<string, ReminderSourceIssue>;
  scannedDigests: Map<string, string>;
  discoveredProjects: Set<string>;
  lookupStore: ReminderLookupStore;
  optimisticState: ReminderOptimisticState;
  /** Identity owners shared by a deferred-scan flush, kept in step with the index. */
  batchOwners?: ReminderIdentityOwners;
}

export interface FileScanUpdate {
  filePath: string;
  project: string;
  /** Digest of the scanned content, when it could be read. */
  digest?: string;
  result: FileScanResult;
}

export type FileScanOutcome =
  | { applied: false; error: string }
  | { applied: true; reminders: IndexedReminder[]; ambiguousOwners: ReminderIdentityOwner[] };

/** Applies a finished, non-deferred single-file scan. A failed scan records a source
 * issue and keeps the previous reminders for the file; a successful one replaces them
 * and transfers any identity owners the scan released. Does no I/O. */
export function applyFileScanResult(state: FileScanState, { filePath, project, digest, result }: FileScanUpdate): FileScanOutcome {
  if (result.error) {
    state.scannedDigests.delete(filePath);
    state.sourceIssues.set(filePath, { path: filePath, reason: result.error, ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}) });
    return { applied: false, error: result.error };
  }

  state.sourceIssues.delete(filePath);
  if (digest) state.scannedDigests.set(filePath, digest);

  state.discoveredProjects.add(project);

  const persistedReminders = state.lookupStore.getByFile(filePath);
  state.optimisticState.clearFileState(filePath, [...persistedReminders, ...result.reminders]);

  const released = result.releasedOwners ?? [];
  const ambiguousOwners = releaseReminderIdentityOwners(state.batchOwners, state.ambiguousOwners, released, filePath);
  const reminders = releaseReminderIdentityOwners(state.batchOwners, state.reminders, released, filePath);
  if (state.batchOwners) addReminderIdentityOwners(state.batchOwners, result.reminders);

  reminders.push(...result.reminders);
  // A move can release an indexed owner that has not received its own
  // refresh yet. Publish the ownership transfer as one index transition.
  if (released.length) state.lookupStore.rebuild(reminders);
  else {
    state.lookupStore.removeFile(filePath);
    state.lookupStore.addReminders(result.reminders);
  }
  return { applied: true, reminders, ambiguousOwners };
}
