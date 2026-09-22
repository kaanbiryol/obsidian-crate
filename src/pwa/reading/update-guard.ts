import { readingDatabase } from './storage';
export async function hasUnsettledReading(): Promise<boolean> {
  if (document.querySelector('.crate-reading__capture')) return true;
  const db = await readingDatabase(), tx = db.transaction('values');
  for (const key of await tx.store.getAllKeys()) {
    if (String(key).startsWith('pending:')) { const value: unknown = await tx.store.get(key); if (!Array.isArray(value) || value.length > 0) return true; }
  }
  return false;
}
