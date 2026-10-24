import { hasEarlierReadingChanges } from './storage/storage';
import { hasOpenReadingForm } from '@/reading/ui/open-forms';

export async function hasUnsettledReading(): Promise<boolean> {
  if (hasOpenReadingForm()) return true;
  return hasEarlierReadingChanges();
}
