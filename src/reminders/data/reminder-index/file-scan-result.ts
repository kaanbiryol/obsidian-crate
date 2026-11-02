import type { IndexedReminder } from "./index";
import type { ReminderLookupStore } from "./lookup-store";
import type { ReminderOptimisticState } from "./optimistic-state";
import type { FileScanResult, ScanResult } from "../vaultScanner";
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

/** The index state a whole-folder scan replaces. */
export interface VaultScanState {
	reminders: IndexedReminder[];
	ambiguousOwners: ReminderIdentityOwner[];
	sourceIssues: Map<string, ReminderSourceIssue>;
	discoveredProjects: Set<string>;
	/** Whether an earlier scan already published reminders. */
	isLoaded: boolean;
}

export interface VaultScanOutcome extends Omit<VaultScanState, 'isLoaded'> {
	/** False when the scan stopped early and the whole load waits for later. */
	complete: boolean;
	/** Files to rescan on a later flush. */
	retryPaths: string[];
}

/** Merges a finished folder scan into the index state without changing the inputs.
 * Files held back individually keep their previous records and issues. Does no I/O. */
export function applyVaultScanResult(state: VaultScanState, result: ScanResult): VaultScanOutcome {
	if (result.deferred && !result.deferredPaths) {
		const sourceIssues = new Map(state.sourceIssues);
		for (const issue of result.issues) sourceIssues.set(issue.path, issue);
		return {
			complete: false,
			reminders: state.isLoaded ? state.reminders : result.reminders,
			ambiguousOwners: result.ambiguousOwners ?? state.ambiguousOwners,
			sourceIssues,
			discoveredProjects: state.isLoaded ? state.discoveredProjects : new Set(result.discoveredProjects),
			retryPaths: [],
		};
	}

	const heldBack = new Set(result.deferredPaths);
	const sourceIssues = new Map(result.issues.map(issue => [issue.path, issue]));
	for (const path of heldBack) {
		const issue = state.sourceIssues.get(path);
		if (issue) sourceIssues.set(path, issue);
	}
	// Before the first load there are no previous records, so held-back files
	// show what could be read without normalizing them.
	const fresh = state.isLoaded ? result.reminders.filter(reminder => !heldBack.has(reminder.filePath)) : result.reminders;
	return {
		complete: true,
		reminders: [...fresh, ...state.reminders.filter(reminder => sourceIssues.has(reminder.filePath) || heldBack.has(reminder.filePath))],
		ambiguousOwners: result.ambiguousOwners ?? [],
		sourceIssues,
		discoveredProjects: new Set(result.discoveredProjects),
		// Notes whose normalization is still to be written retry on a later flush.
		retryPaths: [...heldBack, ...result.writeDeferredPaths ?? []],
	};
}
