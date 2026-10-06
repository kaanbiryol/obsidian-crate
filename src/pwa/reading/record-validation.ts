import { isRecord } from '@/platform/validation';
import { validateReadingMetadata, type ReadingItem } from '@/reading/core/model';

/** Live responses and offline copies share the same item and article contract. */
export function isReadingItem(value: unknown, folder: string): value is ReadingItem {
  if (!isRecord(value) || typeof value.path !== 'string') return false;
  if (value.path && (!value.path.startsWith(`${folder}/`) || value.path.split('/').some(part => !part || part === '.' || part === '..'))) return false;
  try { validateReadingMetadata(value); return true; } catch { return false; }
}

export interface ReadingArticle { item: ReadingItem; markdown: string }
export function isReadingArticle(value: unknown, folder: string, expectedId?: string): value is ReadingArticle {
  return isRecord(value) && isReadingItem(value.item, folder) && typeof value.markdown === 'string'
    && (expectedId === undefined || value.item.crate_reading_id === expectedId);
}
