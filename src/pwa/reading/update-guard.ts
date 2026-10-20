import { hasEarlierReadingChanges } from './storage';
export async function hasUnsettledReading(): Promise<boolean> {
  if (document.querySelector('.crate-reading__capture')) return true;
  return hasEarlierReadingChanges();
}
