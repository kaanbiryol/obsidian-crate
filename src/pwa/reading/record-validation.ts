import { isRecord } from '@/platform/validation';
import { validateReadingMetadata, type ReadingItem } from '@/reading/core/model';

/** Live responses and offline copies share the same item and article contract. */
export function isReadingItem(value: unknown, folder: string): value is ReadingItem {
  return parseReadingItem(value, folder) !== null;
}

function parseReadingItem(value: unknown, folder: string): ReadingItem | null {
  if (!isRecord(value) || typeof value.path !== 'string') return null;
  if (value.path && (!value.path.startsWith(`${folder}/`) || value.path.split('/').some(part => !part || part === '.' || part === '..'))) return null;
  try { return { ...validateReadingMetadata(value), path: value.path }; } catch { return null; }
}

interface ReadingListPage {
  items: ReadingItem[];
  issues: Array<{ path: string; message: string }>;
  cursor: string | null;
}

/** Reject a partial or malformed page before it enters the accumulated revision. */
export function parseReadingListPage(value: unknown, folder: string): ReadingListPage | null {
  if (!isRecord(value) || !Array.isArray(value.items) || !Array.isArray(value.issues)
    || !(value.cursor === null || typeof value.cursor === 'string' && value.cursor.length > 0 && value.cursor.length <= 4096)) return null;
  if (!value.issues.every((issue: unknown): issue is ReadingListPage['issues'][number] =>
    isRecord(issue) && typeof issue.path === 'string' && typeof issue.message === 'string')) return null;
  const items: ReadingItem[] = [];
  for (const valueItem of value.items) {
    const item = parseReadingItem(valueItem, folder);
    if (!item) return null;
    items.push(item);
  }
  return { items, issues: value.issues, cursor: value.cursor };
}

export interface ReadingArticle { item: ReadingItem; markdown: string }
export function isReadingArticle(value: unknown, folder: string, expectedId?: string): value is ReadingArticle {
  return isRecord(value) && isReadingItem(value.item, folder) && typeof value.markdown === 'string'
    && (expectedId === undefined || value.item.crate_reading_id === expectedId);
}
