import { getPortablePathIssue, getSyncPathIssue, portablePathKey } from '../protocol/portable-path';

export interface ReadingSettings { enabled: boolean; folderPath: string }
export const DEFAULT_READING_SETTINGS: ReadingSettings = { enabled: false, folderPath: 'Reading' };

export function validateReadingFolder(value: string, remindersFolder?: string, configDir?: string): string {
	const folder = value.trim();
	const issue = getSyncPathIssue(folder) || getPortablePathIssue(folder);
	if (issue) throw new Error(`Invalid reading folder: ${issue}.`);
	const key = portablePathKey(folder);
	const overlaps = (other: string) => {
		const normalized = portablePathKey(other);
		return key === normalized || key.startsWith(`${normalized}/`) || normalized.startsWith(`${key}/`);
	};
	if (folder.split('/').some(segment => segment.startsWith('.')) || configDir && overlaps(configDir)) throw new Error('Choose a visible folder outside the vault configuration.');
	if (remindersFolder && overlaps(remindersFolder)) throw new Error('Reading and reminders need separate folders.');
	return folder;
}

export function normalizeReadingSettings(value: unknown): ReadingSettings {
	if (!value || typeof value !== 'object') return { ...DEFAULT_READING_SETTINGS };
	const settings = value as Partial<ReadingSettings>;
	try {
		return { enabled: settings.enabled === true, folderPath: validateReadingFolder(typeof settings.folderPath === 'string' ? settings.folderPath : 'Reading') };
	} catch { return { ...DEFAULT_READING_SETTINGS }; }
}
