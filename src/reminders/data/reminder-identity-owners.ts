import { TFile, type App } from 'obsidian';
import { parseCheckboxLine } from '../core/grammar/checkboxParser';
import { markdownTaskContexts } from '../core/markdownTaskContext';
import { extractReminderId } from '../core/reminderIdentity';
import { readVaultMarkdown } from './vault-markdown';

export interface ReminderIdentityOwner { id: string; filePath: string }
export type ReminderIdentityOwners = Map<string, Set<string>>;

export function addReminderIdentityOwners(owners: ReminderIdentityOwners, reminders: ReminderIdentityOwner[]): void {
	for (const reminder of reminders) {
		const paths = owners.get(reminder.id) ?? new Set<string>();
		paths.add(reminder.filePath);
		owners.set(reminder.id, paths);
	}
}

/** Only lines whose marker is wanted are parsed; the marker alone rules out the rest. */
function contentIds(content: string, wanted: (id: string) => boolean): Set<string> {
	const ids = new Set<string>();
	const lines = content.split('\n');
	for (const index of markdownTaskContexts(lines).keys()) {
		const line = lines[index]!;
		const marker = extractReminderId(line);
		if (!marker || !wanted(marker)) continue;
		const parsed = parseCheckboxLine(line);
		if (parsed?.reminderId && parsed.parsed.cleanContent.trim()) ids.add(parsed.reminderId);
	}
	return ids;
}

/** The index identifies possible owners; only current Markdown can confirm them. */
export async function resolveReminderIdentityOwners(
	app: App,
	filePath: string,
	content: string,
	owners: ReminderIdentityOwners,
): Promise<{ reservedIds: Set<string>; releasedOwners: ReminderIdentityOwner[]; isCurrent: () => boolean }> {
	const candidates = new Map<string, Set<string>>();
	const ownedElsewhere = (id: string) => [...owners.get(id) ?? []].some(path => path !== filePath);
	for (const id of contentIds(content, ownedElsewhere)) {
		for (const ownerPath of owners.get(id) ?? []) {
			if (ownerPath === filePath) continue;
			const ids = candidates.get(ownerPath) ?? new Set<string>();
			ids.add(id);
			candidates.set(ownerPath, ids);
		}
	}
	const reservedIds = new Set<string>();
	const releasedOwners: ReminderIdentityOwner[] = [];
	const observedFiles = new Map<string, string | null>();
	const version = (file: TFile) => `${file.stat.ctime}:${file.stat.mtime}:${file.stat.size}`;
	await Promise.all([...candidates].map(async ([ownerPath, ids]) => {
		const owner = app.vault.getAbstractFileByPath(ownerPath);
		observedFiles.set(ownerPath, owner instanceof TFile ? version(owner) : null);
		// A failed read must fail the scan, never authorize replacing an identity.
		const currentIds = owner instanceof TFile ? contentIds(await readVaultMarkdown(app, owner), id => ids.has(id)) : new Set<string>();
		for (const id of ids) {
			if (currentIds.has(id)) reservedIds.add(id);
			else releasedOwners.push({ id, filePath: ownerPath });
		}
	}));
	return { reservedIds, releasedOwners, isCurrent: () => [...observedFiles].every(([path, observed]) => {
		const current = app.vault.getAbstractFileByPath(path);
		return (current instanceof TFile ? version(current) : null) === observed;
	}) };
}
