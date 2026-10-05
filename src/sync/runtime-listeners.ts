import type { SyncState } from './types';

export function emitStateChange(
  listeners: Set<(state: SyncState) => void>,
  state: SyncState,
): void {
  for (const listener of listeners) {
    listener(state);
  }
}

export function emitSyncProgress(
  listeners: Set<(current: number, total: number) => void>,
  current: number,
  total: number,
  options?: {
    onExternalProgress?: (current: number, total: number) => void;
  },
): void {
  options?.onExternalProgress?.(current, total);
  for (const listener of listeners) {
    listener(current, total);
  }
}
