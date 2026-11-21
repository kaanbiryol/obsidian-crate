import { isRecord } from '../platform/validation';

/** How saved articles keep their images: copies in the vault, or the website's own links. */
export type ReadingImageMode = 'save' | 'remote';

/** Feature switches shared by every device connected to one server. */
export interface SharedFeatures { reading: boolean; reminders: boolean }

/** The `/features` policy; `revision` stays null until the policy is first saved. A missing
 * `readingImages` means `save`: only the other choice is stored, and older servers store none. */
export interface FeaturePolicy extends SharedFeatures { revision: string | null; readingImages?: ReadingImageMode }

export function parseSharedFeatures(value: unknown): SharedFeatures | null {
	if (!isRecord(value) || typeof value.reading !== 'boolean' || typeof value.reminders !== 'boolean') return null;
	return { reading: value.reading, reminders: value.reminders };
}

export function parseFeaturePolicy(value: unknown): FeaturePolicy | null {
	const features = parseSharedFeatures(value);
	const revision = isRecord(value) ? value.revision : undefined;
	if (!features || (typeof revision !== 'string' && revision !== null)) return null;
	return { ...features, revision, ...(isRecord(value) && value.readingImages === 'remote' ? { readingImages: 'remote' as const } : {}) };
}
