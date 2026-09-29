import { isRecord } from '@/platform/validation';
import { reminderOperationDay } from '@/protocol/reminder-operation';
import { readingHighlights } from '@/reading/core/highlights';
import { readingTimestamp, readingUrl, validateReadingMetadata, type ReadingItem } from '@/reading/core/model';
import type { PendingReading, ReadingCache, ReadingSession } from './storage';

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const nonNegativeNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function isReadingSession(value: unknown): value is ReadingSession {
  return isRecord(value) && nonEmptyString(value.token) && nonEmptyString(value.id)
    && nonEmptyString(value.folderPath) && nonEmptyString(value.generation) && nonNegativeNumber(value.expiresAt)
    && (value.source === undefined || value.source === 'reminders');
}

function isReadingItem(value: unknown, folder: string): value is ReadingItem {
  if (!isRecord(value) || typeof value.path !== 'string') return false;
  if (value.path && (!value.path.startsWith(`${folder}/`) || value.path.split('/').some(part => !part || part === '.' || part === '..'))) return false;
  try { validateReadingMetadata(value); return true; } catch { return false; }
}

export function isReadingCache(value: unknown, folder: string): value is ReadingCache {
  if (!isRecord(value) || !nonNegativeNumber(value.savedAt) || !Array.isArray(value.items) || !Array.isArray(value.issues)) return false;
  const ids = new Set<string>();
  return value.items.every((item: unknown) => {
    if (!isReadingItem(item, folder) || ids.has(item.crate_reading_id)) return false;
    ids.add(item.crate_reading_id); return true;
  }) && value.issues.every((issue: unknown) => isRecord(issue) && typeof issue.path === 'string' && typeof issue.message === 'string');
}

export interface ReadingArticleCache { item: ReadingItem; markdown: string; usedAt: number }
export function isReadingArticleCache(value: unknown, folder: string): value is ReadingArticleCache {
  return isRecord(value) && isReadingItem(value.item, folder) && typeof value.markdown === 'string' && nonNegativeNumber(value.usedAt);
}

export function isReadingDraft(value: unknown): value is { url: string } {
  // Drafts may contain incomplete URLs; validate their representation, not form validity.
  return isRecord(value) && typeof value.url === 'string';
}

function isChangeField(key: string, value: unknown, before: boolean): boolean {
  if (key === 'favorite') return typeof value === 'boolean';
  if (key === 'reading_status') return value === 'inbox' || value === 'archived';
  if (key === 'tags') return Array.isArray(value) && value.length <= 50
    && value.every(tag => typeof tag === 'string' && !!tag.trim() && tag.length <= 100);
  if (key === 'highlights') {
    if (before && value === undefined) return true;
    try { readingHighlights(value); return true; } catch { return false; }
  }
  return false;
}

export function isReadingIntent(action: PendingReading['action'], value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || 'operationId' in value) return false;
  if (action === 'capture') {
    try { readingUrl(value.url); } catch { return false; }
    return (value.title === undefined || typeof value.title === 'string' && value.title.length <= 1000)
      && (value.fetchArticle === undefined || typeof value.fetchArticle === 'boolean');
  }
  if (!nonEmptyString(value.id)) return false;
  if (action === 'retry') return true;
  if (!isRecord(value.changes) || !isRecord(value.before)) return false;
  const before = value.before;
  return Object.keys(value.changes).length > 0 && Object.entries(value.changes).every(([key, field]) =>
    isChangeField(key, field, false) && isChangeField(key, before[key], true));
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value: unknown, index) => sameJson(value, right[index]));
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).filter(key => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter(key => right[key] !== undefined);
  return leftKeys.length === rightKeys.length && leftKeys.every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

/** Validate in place. Dispatch bytes and unknown metadata are never rewritten. */
export function isPendingReading(value: unknown, sessionId: string): value is PendingReading {
  if (!isRecord(value) || !nonEmptyString(value.id) || value.sessionId !== sessionId
    || !['capture', 'update', 'retry'].includes(String(value.action))) return false;
  if (!isReadingIntent(value.action as PendingReading['action'], value.intent)) return false;
  if (value.error !== undefined && typeof value.error !== 'string'
    || value.review !== undefined && typeof value.review !== 'boolean'
    || value.attempts !== undefined && (!nonNegativeNumber(value.attempts) || !Number.isSafeInteger(value.attempts))
    || value.retryAt !== undefined && !nonNegativeNumber(value.retryAt)) return false;
  if (value.queuedAt !== undefined) { try { readingTimestamp(value.queuedAt); } catch { return false; } }
  if (value.body !== undefined) {
    if (typeof value.body !== 'string') return false;
    let body: unknown;
    try { body = JSON.parse(value.body); } catch { return false; }
    if (!isRecord(body) || typeof body.operationId !== 'string' || reminderOperationDay(body.operationId) === null) return false;
    const { operationId: _operationId, ...intent } = body;
    if (!sameJson(intent, value.intent)) return false;
  }
  return true;
}
