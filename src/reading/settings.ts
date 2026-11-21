import { getPortablePathIssue, getSyncPathIssue, portablePathKey } from '../protocol/portable-path';
import { DEFAULT_READING_IMAGE_MODE, readingImageMode, type ReadingImageMode } from './core/article-images';

export interface ReadingSettings {
	enabled: boolean;
	folderPath: string;
	/** This vault agreed to let Crate change notes in the folder. A server policy alone never sets it. */
	confirmed: boolean;
	/** Whether saved articles keep copies of their images in the vault or load them from the website. Missing means the default. */
	images?: ReadingImageMode;
}
/** A fresh install: Reading changes no notes until it is turned on in this vault. */
export const DEFAULT_READING_SETTINGS: ReadingSettings = { enabled: false, folderPath: 'Reading', confirmed: false };

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

/** Reading runs only in a vault that confirmed it. */
export function normalizeReadingSettings(value: unknown): ReadingSettings {
	const settings = value && typeof value === 'object' ? value as Partial<ReadingSettings> : {};
	const confirmed = typeof settings.confirmed === 'boolean' ? settings.confirmed : DEFAULT_READING_SETTINGS.confirmed;
	const enabled = confirmed && (typeof settings.enabled === 'boolean' ? settings.enabled : DEFAULT_READING_SETTINGS.enabled);
	// Only a choice other than the default is stored.
	const images = readingImageMode(settings.images) === DEFAULT_READING_IMAGE_MODE ? {} : { images: readingImageMode(settings.images) };
	try {
		return { enabled, confirmed, ...images, folderPath: validateReadingFolder(typeof settings.folderPath === 'string' ? settings.folderPath : 'Reading') };
	} catch { return { enabled, confirmed, ...images, folderPath: DEFAULT_READING_SETTINGS.folderPath }; }
}
