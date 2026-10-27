/**
 * Reminder Index - In-memory index derived from markdown files
 *
 * Provides fast queries for reminders parsed from vault markdown files.
 * This is NOT the source of truth - markdown files are.
 * The index is rebuilt from markdown on startup and updated incrementally.
 */

import { TFile, type App } from "obsidian";
import type { ScannedReminderRecord } from "@/reminders/core/markdownScan";
import { createLogger } from "@/reminders/logger";
import { createReminderLookupStore } from "./lookup-store";
import { createReminderOptimisticState } from "./optimistic-state";
import { isInRemindersFolder, scanFile, scanVault, type ScanResult } from "../vaultScanner";
import { getProjectFromPath } from "@/reminders/core/markdownScan";
import { addReminderIdentityOwners, type ReminderIdentityOwner, type ReminderIdentityOwners } from '../reminder-identity-owners';
import { applyFileScanResult } from './file-scan-result';
import type { ReminderSourceIssue } from '../reminder-source-issues';
import { readVaultMarkdown } from '@/sync/local/vault-markdown';
import { sha256Hex } from '../../../platform/sha256';

const contentDigest = sha256Hex;

const log = createLogger("ReminderIndex");

type IndexChangeListener = () => void;

/** A scanned record; the index also accepts records without a project, which
 * read as the default project. */
export type IndexedReminder = Omit<ScannedReminderRecord, 'project'> & { project?: string };

export interface ReminderIndex {
	readonly isInitialLoadComplete: boolean;
	readonly sourceIssues: ReminderSourceIssue[];
	remindersFolderPath: string;

	getAll(): IndexedReminder[];
	getActive(): IndexedReminder[];
	getById(id: string): IndexedReminder | undefined;
	getProjects(): string[];

	load(): Promise<ScanResult>;
	rescanFile(file: TFile): Promise<void>;
	flushDeferredScans(): Promise<void>;
	removeFile(filePath: string): void;
	renameFile(oldPath: string, newPath: string): void;

	isReminderFile(filePath: string): boolean;
	onIndexChange(listener: IndexChangeListener): () => void;

	applyOptimisticCreate(reminder: IndexedReminder): void;
	applyOptimisticUpdate(id: string, updates: Partial<IndexedReminder>): void;
	applyOptimisticDelete(id: string): void;
	clearOptimistic(id: string): void;
}

export interface ReminderIndexOptions {
	signal?: AbortSignal;
	/** Holds scans until the vault and sync can be read safely; whole-vault checks omit the path. */
	shouldDeferScan?: (filePath?: string) => boolean;
	/** Holds duplicate-ID repair until sync has reconciled file ownership. */
	shouldDeferCollisionRepair?: () => boolean;
}

export function createReminderIndex(
	app: App,
	remindersFolderPath: string,
	{ signal, shouldDeferScan = () => false, shouldDeferCollisionRepair = () => false }: ReminderIndexOptions = {},
): ReminderIndex {
	let reminders: IndexedReminder[] = [];
	let isLoaded = false;
	let isInitialLoadComplete = false;
	let discoveredProjects = new Set<string>();
	let ambiguousOwners: ReminderIdentityOwner[] = [];
	let sourceIssues = new Map<string, ReminderSourceIssue>();

	const listeners = new Set<IndexChangeListener>();
	const lookupStore = createReminderLookupStore();
	const optimisticState = createReminderOptimisticState();
	let scanQueue: Promise<unknown> = Promise.resolve();
	let structureRevision = 0;
	const pendingFileScans = new Set<{ path: string; current: boolean }>();
	// Content digests from the last successful single-file scan. A writer rescans
	// its own edit immediately and the watcher reports it again; an unchanged note
	// skips the identity rebuild and listener notification.
	const scannedDigests = new Map<string, string>();
	function invalidateScans(...paths: string[]): void {
		structureRevision++;
		for (const path of paths) scannedDigests.delete(path);
		for (const scan of pendingFileScans) if (paths.includes(scan.path)) scan.current = false;
	}
	let deferredLoad = false;
	const deferredPaths = new Set<string>();
	const enqueueScan = <T>(scan: () => Promise<T>): Promise<T> => {
		const result = scanQueue.then(scan, scan);
		scanQueue = result.then(() => undefined, () => undefined);
		return result;
	};
	signal?.addEventListener('abort', () => { deferredPaths.clear(); deferredLoad = false; }, { once: true });

	function notifyListeners(): void {
		for (const listener of listeners) {
			try {
				listener();
			} catch (error) {
				log.error("Error in index change listener:", error);
			}
		}
	}

	// A deferred-scan flush shares one identity-owner map across its files and
	// publishes the combined result with a single notification.
	let batch: { owners?: ReminderIdentityOwners; changed: boolean } | undefined;
	function publishChange(): void {
		if (batch) batch.changed = true;
		else notifyListeners();
	}

	function buildIdentityOwners(): ReminderIdentityOwners {
		const owners: ReminderIdentityOwners = new Map();
		addReminderIdentityOwners(owners, reminders);
		addReminderIdentityOwners(owners, ambiguousOwners);
		return owners;
	}

	/** Runs inside the scan queue; returns whether the index changed. */
	async function rescanQueued(file: TFile, scan: { path: string; current: boolean }): Promise<boolean> {
		if (signal?.aborted || !scan.current || file.path !== scan.path) return false;
		const filePath = scan.path;
		if (!isInRemindersFolder(filePath, remindersFolderPath)) {
			return false;
		}
		if (shouldDeferScan(filePath)) {
			deferredPaths.add(filePath);
			return false;
		}
		// A read failure here is reported by the full scan below.
		const content = await readVaultMarkdown(app.vault, file).catch(() => undefined);
		const digest = content === undefined ? undefined : await contentDigest(content);
		if (signal?.aborted || !scan.current || file.path !== scan.path) return false;
		if (digest && scannedDigests.get(filePath) === digest && !sourceIssues.has(filePath)) return false;

		log.info(` Rescanning file: ${filePath}`);

		const identityOwners = batch ? (batch.owners ??= buildIdentityOwners()) : buildIdentityOwners();
		const result = await scanFile(app, file, remindersFolderPath, {
			signal,
			identityOwners,
			shouldDeferNormalization: () => !scan.current || file.path !== scan.path || shouldDeferScan(filePath),
			shouldDeferCollisionRepair,
			preread: content,
		});
		if (signal?.aborted || !scan.current || file.path !== scan.path) return false;
		if (result.deferred) { deferredPaths.add(filePath); return false; }
		const outcome = applyFileScanResult({
			reminders, ambiguousOwners, sourceIssues, scannedDigests, discoveredProjects, lookupStore, optimisticState, batchOwners: batch?.owners,
		}, { filePath, project: getProjectFromPath(filePath, remindersFolderPath), digest, result });
		if (!outcome.applied) {
			log.error(` Keeping the previous reminder index for ${filePath}: ${outcome.error}`);
			publishChange();
			return false;
		}
		reminders = outcome.reminders;
		ambiguousOwners = outcome.ambiguousOwners;
		publishChange();

		log.info(` File rescanned, found ${result.reminders.length} reminders`);
		return true;
	}

	function getMergedReminders(): IndexedReminder[] {
		return optimisticState.mergeReminders(reminders);
	}

	const index: ReminderIndex = {
		get isInitialLoadComplete() { return isInitialLoadComplete; },
		get sourceIssues() { return [...sourceIssues.values()]; },
		get remindersFolderPath() {
			return remindersFolderPath;
		},

		getAll() {
			return getMergedReminders();
		},

		getActive() {
			return getMergedReminders().filter((reminder) => !reminder.completed);
		},

		getById(id: string) {
			return optimisticState.getById(id, lookupStore.getById(id));
		},

		getProjects() {
			return lookupStore.getProjects(discoveredProjects);
		},

		isReminderFile(filePath: string) {
			return isInRemindersFolder(filePath, remindersFolderPath);
		},

		load: () => enqueueScan(async () => {
			if (signal?.aborted || shouldDeferScan()) {
				deferredLoad = !signal?.aborted;
				return { reminders, issues: [...sourceIssues.values()], filesScanned: 0, totalLines: 0, scanDurationMs: 0, discoveredProjects: [...discoveredProjects], deferred: true };
			}
			log.info(` Starting scan of ${remindersFolderPath}/...`);
			let result: ScanResult;
			let revision: number;
			do {
				revision = structureRevision;
				result = await scanVault(app, remindersFolderPath, {
					signal,
					shouldDeferNormalization: path => revision !== structureRevision || shouldDeferScan(path),
					shouldDeferCollisionRepair,
					knownOwners: [...reminders, ...ambiguousOwners],
				});
				// A rename or deletion updates the visible index immediately. Re-read
				// the inventory before publishing a snapshot that crossed that event.
			} while (!signal?.aborted && revision !== structureRevision);
			if (signal?.aborted) return result;
			// Only a scan that stopped early leaves the whole load for later. Files held
			// back individually keep their previous records and are rescanned on flush.
			if (result.deferred && !result.deferredPaths) {
				deferredLoad = true;
				for (const issue of result.issues) sourceIssues.set(issue.path, issue);
				ambiguousOwners = result.ambiguousOwners ?? ambiguousOwners;
				if (!isLoaded) {
					reminders = result.reminders;
					discoveredProjects = new Set(result.discoveredProjects);
					lookupStore.rebuild(reminders);
					isLoaded = true;
				}
				notifyListeners();
				return result;
			}

			const heldBack = new Set(result.deferredPaths);
			deferredLoad = false;
			isInitialLoadComplete = true;
			const previousIssues = sourceIssues;
			sourceIssues = new Map(result.issues.map(issue => [issue.path, issue]));
			for (const path of heldBack) {
				const issue = previousIssues.get(path);
				if (issue) sourceIssues.set(path, issue);
				deferredPaths.add(path);
			}
			// Before the first load there are no previous records, so held-back files
			// show what could be read without normalizing them.
			const fresh = isLoaded ? result.reminders.filter(reminder => !heldBack.has(reminder.filePath)) : result.reminders;
			reminders = [...fresh, ...reminders.filter(reminder => sourceIssues.has(reminder.filePath) || heldBack.has(reminder.filePath))];
			ambiguousOwners = result.ambiguousOwners ?? [];
			isLoaded = true;
			discoveredProjects = new Set(result.discoveredProjects);

			lookupStore.rebuild(reminders);
			scannedDigests.clear();
			notifyListeners();

			log.info(` Index loaded with ${reminders.length} reminders from ${result.filesScanned} files`);
			return result;
		}),

		rescanFile: (file: TFile) => {
			// Capture the path when work is requested, including time spent queued.
			// The watcher owns debounce; an accepted scan must not drop a newer edit.
			const scan = { path: file.path, current: true };
			pendingFileScans.add(scan);
			return enqueueScan(async () => {
				if (await rescanQueued(file, scan) && deferredPaths.size) {
					void index.flushDeferredScans().catch(error => log.error('Deferred reminder scan failed:', error));
				}
			}).finally(() => pendingFileScans.delete(scan));
		},

		async flushDeferredScans() {
			await scanQueue;
			if (signal?.aborted || shouldDeferScan()) return;
			if (deferredLoad) {
				deferredLoad = false;
				deferredPaths.clear();
				await index.load();
				return;
			}
			const paths = [...deferredPaths];
			deferredPaths.clear();
			const rescanned = await enqueueScan(async () => {
				const current = batch = { changed: false };
				let anyRescanned = false;
				try {
					for (const path of paths) {
						if (signal?.aborted) return anyRescanned;
						const file = app.vault.getAbstractFileByPath(path);
						if (!(file instanceof TFile)) { index.removeFile(path); continue; }
						const scan = { path, current: true };
						pendingFileScans.add(scan);
						try {
							if (await rescanQueued(file, scan)) anyRescanned = true;
						} finally {
							pendingFileScans.delete(scan);
						}
					}
					return anyRescanned;
				} finally {
					batch = undefined;
					if (current.changed) notifyListeners();
				}
			});
			if (rescanned && deferredPaths.size) void index.flushDeferredScans().catch(error => log.error('Deferred reminder scan failed:', error));
		},

		removeFile(filePath: string) {
			invalidateScans(filePath);
			if (batch) batch.owners = undefined;
			deferredPaths.delete(filePath);
			sourceIssues.delete(filePath);
			ambiguousOwners = ambiguousOwners.filter(owner => owner.filePath !== filePath);
			log.info(` Removing file from index: ${filePath}`);
			const before = reminders.length;

			lookupStore.removeFile(filePath);
			reminders = reminders.filter((reminder) => reminder.filePath !== filePath);
			optimisticState.clearFileState(filePath, []);
			discoveredProjects.delete(getProjectFromPath(filePath, remindersFolderPath));

			publishChange();
			log.info(` Removed ${before - reminders.length} reminders`);
		},

		renameFile(oldPath: string, newPath: string) {
			invalidateScans(oldPath, newPath);
			if (batch) batch.owners = undefined;
			if (deferredPaths.delete(oldPath)) deferredPaths.add(newPath);
			const issue = sourceIssues.get(oldPath);
			if (issue) { sourceIssues.delete(oldPath); sourceIssues.set(newPath, { ...issue, path: newPath }); }
			ambiguousOwners = ambiguousOwners.map(owner => owner.filePath === oldPath ? { ...owner, filePath: newPath } : owner);
			log.info(` Renaming file in index: ${oldPath} -> ${newPath}`);

			const oldProject = getProjectFromPath(oldPath, remindersFolderPath);
			const newProject = getProjectFromPath(newPath, remindersFolderPath);
			discoveredProjects.delete(oldProject);
			discoveredProjects.add(newProject);

			// The index owns records; lookup maps only track the published values.
			// Remove the old keys before changing the records they reference.
			const moved = lookupStore.removeFile(oldPath);
			for (const reminder of moved) {
				reminder.filePath = newPath;
				reminder.project = newProject;
			}
			lookupStore.addReminders(moved);
			notifyListeners();
		},

		onIndexChange(listener: IndexChangeListener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		applyOptimisticCreate(reminder: IndexedReminder) {
			optimisticState.applyCreate(reminder);
			notifyListeners();
		},

		applyOptimisticUpdate(id: string, updates: Partial<IndexedReminder>) {
			optimisticState.applyUpdate(id, updates);
			notifyListeners();
		},

		applyOptimisticDelete(id: string) {
			optimisticState.applyDelete(id);
			notifyListeners();
		},

		clearOptimistic(id: string) {
			optimisticState.clear(id);
			notifyListeners();
		},
	};
	return index;
}
