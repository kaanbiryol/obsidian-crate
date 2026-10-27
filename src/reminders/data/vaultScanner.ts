/**
 * Vault Scanner - Scans a specific folder for reminder syntax in markdown files
 *
 * Only scans files within the configured reminders folder.
 * Each file represents a project (filename = project name).
 *
 * Finds markdown checkbox lines:
 * - [ ] task content @date #project !
 * - [x] completed task
 */

import { normalizePath, TAbstractFile, TFile, TFolder, type App } from "obsidian";
import {
	getProjectFromPath as deriveProjectFromPath,
	scanReminderMarkdownContent,
} from "@/reminders/core/markdownScan";
import { createPersistedCheckboxParses } from "@/reminders/core/grammar/checkboxParser";
import { normalizeReminderIds } from "@/reminders/core/normalizeReminderIds";
import { compareProjects } from "@/reminders/core/reminder-list";
import { createLogger } from "@/reminders/logger";
import type { IndexedReminder } from "./reminder-index";
import { addReminderIdentityOwners, releaseReminderIdentityOwners, resolveReminderIdentityOwners, type ReminderIdentityOwner, type ReminderIdentityOwners } from './reminder-identity-owners';
import { readVaultMarkdown, processVaultMarkdown, VaultMarkdownChangedError } from '@/sync/local/vault-markdown';
import { reminderSourceDiagnostic, type ReminderSourceIssue } from './reminder-source-issues';
import { isConflictFile } from '@/sync/conflict/conflict';

const log = createLogger('VaultScanner');

export interface ScanResult {
	reminders: IndexedReminder[];
	issues: ReminderSourceIssue[];
	filesScanned: number;
	totalLines: number;
	scanDurationMs: number;
	discoveredProjects: string[]; // All projects from file paths, including empty ones
	deferred?: boolean;
	/** Set when every file was read and only these files were held back. */
	deferredPaths?: string[];
	ambiguousOwners?: ReminderIdentityOwner[];
}

export interface FileScanResult {
	filePath: string;
	reminders: IndexedReminder[];
	lineCount: number;
	error?: string;
	diagnostic?: ReminderSourceIssue['diagnostic'];
	releasedOwners?: ReminderIdentityOwner[];
	deferred?: boolean;
}

/**
 * Check if a file is within the reminders folder
 */
export function isInRemindersFolder(filePath: string, remindersFolderPath: string): boolean {
	const normalizedFile = normalizePath(filePath);
	if (isConflictFile(normalizedFile)) return false;
	const normalizedFolder = normalizePath(remindersFolderPath);
	return normalizedFile.startsWith(normalizedFolder + "/") || normalizedFile === normalizedFolder;
}

function collectMarkdownFilesInFolder(app: App, remindersFolderPath: string): TFile[] {
	const normalizedFolderPath = remindersFolderPath.replace(/^\/|\/$/g, '');
	const rootEntry = normalizedFolderPath
		? app.vault.getAbstractFileByPath(normalizedFolderPath)
		: app.vault.getRoot();

	if (!rootEntry) {
		log.warn(` Reminders folder not found: ${remindersFolderPath}`);
		return [];
	}

	if (rootEntry instanceof TFile) {
		return rootEntry.extension === "md" ? [rootEntry] : [];
	}

	const files: TFile[] = [];
	const stack: TAbstractFile[] = [rootEntry];

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		if (current instanceof TFolder) {
			for (const child of current.children) {
				stack.push(child);
			}
			continue;
		}
		if (current instanceof TFile && current.extension === "md") {
			files.push(current);
		}
	}

	return files;
}

interface ScanFileOptions {
	reservedIds?: ReadonlySet<string>;
	signal?: AbortSignal;
	identityOwners?: ReminderIdentityOwners;
	shouldDeferNormalization?: () => boolean;
	shouldDeferCollisionRepair?: () => boolean;
	/** Content the caller just read; writes still verify it as their preimage. */
	preread?: string;
}

/**
 * Scan a single file for reminders
 * @param app - Obsidian app instance
 * @param file - File to scan
 * @param remindersFolderPath - Path to the reminders folder (for project derivation)
 */
export async function scanFile(
	app: App,
	file: TFile,
	remindersFolderPath: string,
	{
		reservedIds = new Set(),
		signal,
		identityOwners,
		shouldDeferNormalization = () => false,
		shouldDeferCollisionRepair = () => false,
		preread,
	}: ScanFileOptions = {},
): Promise<FileScanResult> {
	const filePath = file.path;
	const cancelled = { filePath, reminders: [], lineCount: 0 };
	// Conflict copies preserve alternate bytes for review, not active reminders.
	// Never normalize their duplicated IDs or let them claim live identities.
	if (signal?.aborted || isConflictFile(filePath)) return cancelled;

	try {
		const originalContent = preread ?? await readVaultMarkdown(app.vault, file);
		if (signal?.aborted) return cancelled;
		// Schedule normalization and the scan below parse the same unchanged lines.
		const parses = createPersistedCheckboxParses();
		const deferred = (): FileScanResult => ({
			filePath,
			...scanReminderMarkdownContent(filePath, originalContent, remindersFolderPath, { skipUnresolvedSchedules: true }),
			deferred: true,
		});
		const ownership = identityOwners ? await resolveReminderIdentityOwners(app, filePath, originalContent, identityOwners) : undefined;
		if (signal?.aborted) return cancelled;
		const currentReservedIds = new Set([...reservedIds, ...(ownership?.reservedIds ?? [])]);
		const mustDefer = () => shouldDeferNormalization()
			|| (currentReservedIds.size > 0 && shouldDeferCollisionRepair())
			|| (ownership !== undefined && !ownership.isCurrent());
		if (mustDefer()) return deferred();
		let normalized = normalizeReminderIds(originalContent, currentReservedIds, parses.remember);
		if (normalized.remindersUpdated > 0) {
			let remindersUpdated = 0;
			let targetChanged = false;
			const content = await processVaultMarkdown(app.vault, file, (currentContent) => {
				// Ownership was verified for the identifiers in the original bytes.
				// Retry with new evidence if a concurrent edit changes the target.
				if (ownership && currentContent !== originalContent) {
					targetChanged = true;
					return currentContent;
				}
				if (signal?.aborted || mustDefer()) return currentContent;
				const currentNormalization = normalizeReminderIds(currentContent, currentReservedIds, parses.remember);
				remindersUpdated = currentNormalization.remindersUpdated;
				return currentNormalization.content;
			});
			if (targetChanged) return deferred();
			normalized = { content, remindersUpdated };
			if (remindersUpdated > 0) {
				log.info(` Added ${remindersUpdated} reminder identifiers to ${filePath}`);
			}
		}
		if (signal?.aborted) return cancelled;
		if (mustDefer()) return deferred();
		const result = scanReminderMarkdownContent(filePath, normalized.content, remindersFolderPath, { parsePersisted: parses.take });

		return {
			filePath,
			reminders: result.reminders,
			lineCount: result.lineCount,
			...(ownership?.releasedOwners.length ? { releasedOwners: ownership.releasedOwners } : {}),
		};
	} catch (error) {
		if (signal?.aborted) return cancelled;
		if (error instanceof VaultMarkdownChangedError) return { ...cancelled, deferred: true };
		log.error(` Error scanning file ${filePath}:`, error);
		return {
			filePath,
			reminders: [],
			lineCount: 0,
			error: error instanceof Error ? error.message : String(error),
			diagnostic: reminderSourceDiagnostic(error),
		};
	}
}

interface ScanVaultOptions {
	signal?: AbortSignal;
	/** Called without a path before each file, then with the path during its normalization. */
	shouldDeferNormalization?: (filePath?: string) => boolean;
	shouldDeferCollisionRepair?: () => boolean;
	knownOwners?: ReminderIdentityOwner[];
}

/**
 * Scan only the reminders folder for reminder files
 * @param app - Obsidian app instance
 * @param remindersFolderPath - Path to the reminders folder (e.g., "Reminders")
 */
export async function scanVault(
	app: App,
	remindersFolderPath: string,
	{
		signal,
		shouldDeferNormalization = () => false,
		shouldDeferCollisionRepair = () => false,
		knownOwners = [],
	}: ScanVaultOptions = {},
): Promise<ScanResult> {
	const startTime = Date.now();
	let allReminders: IndexedReminder[] = [];
	const issues: ReminderSourceIssue[] = [];
	let filesScanned = 0;
	let totalLines = 0;

	// Only get markdown files within the reminders folder tree
	const reminderFiles = collectMarkdownFilesInFolder(app, remindersFolderPath)
		.filter(file => !isConflictFile(file.path));

	log.info(
		` Found ${reminderFiles.length} files in ${remindersFolderPath || "vault root"}`
	);

	// Collect all project names from file paths (including empty files)
	const discoveredProjects = new Set<string>();
	for (const file of reminderFiles) {
		const project = deriveProjectFromPath(file.path, remindersFolderPath);
		discoveredProjects.add(project);
	}

	// Scan in stable path order so the first occurrence of a pasted identifier
	// remains canonical and later duplicates receive fresh identifiers.
	reminderFiles.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
	const identityOwners: ReminderIdentityOwners = new Map();
	addReminderIdentityOwners(identityOwners, knownOwners);
	let deferred = false;
	let complete = true;
	const deferredPaths: string[] = [];
	for (const file of reminderFiles) {
		if (signal?.aborted) break;
		if (shouldDeferNormalization()) { deferred = true; complete = false; break; }
		const result = await scanFile(app, file, remindersFolderPath, {
			signal, identityOwners, shouldDeferNormalization: () => shouldDeferNormalization(file.path), shouldDeferCollisionRepair,
		});
		if (result.deferred) { deferred = true; deferredPaths.push(file.path); }
		if (result.error) {
			issues.push({ path: result.filePath, reason: result.error, ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}) });
			continue;
		}
		filesScanned++;
		if (result.releasedOwners) allReminders = releaseReminderIdentityOwners(identityOwners, allReminders, result.releasedOwners);
		allReminders.push(...result.reminders);
		totalLines += result.lineCount;
		addReminderIdentityOwners(identityOwners, result.reminders);
	}

	const scanDurationMs = Date.now() - startTime;

	log.info(
		` Scanned ${reminderFiles.length} files, found ${allReminders.length} reminders in ${scanDurationMs}ms`
	);
	const identityCounts = new Map<string, number>();
	if (deferred) for (const reminder of allReminders) identityCounts.set(reminder.id, (identityCounts.get(reminder.id) ?? 0) + 1);

	return {
		// Keep healthy persisted reminders visible while collision repair waits
		// for sync. Neither ambiguous owner is exposed as an editable identity.
		reminders: deferred ? allReminders.filter(reminder => identityCounts.get(reminder.id) === 1) : allReminders,
		issues,
		filesScanned,
		totalLines,
		scanDurationMs,
		discoveredProjects: Array.from(discoveredProjects).sort(compareProjects),
		...(deferred ? { deferred: true } : {}),
		...(deferred && complete ? { deferredPaths } : {}),
		...(deferred ? { ambiguousOwners: allReminders.filter(reminder => (identityCounts.get(reminder.id) ?? 0) > 1)
			.map(({ id, filePath }) => ({ id, filePath })) } : {}),
	};
}
