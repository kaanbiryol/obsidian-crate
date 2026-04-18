import type { SyncState } from "../plugin/types";

export function emitStateChange(
  listeners: Set<(state: SyncState) => void>,
  state: SyncState,
  onStatusBarUpdate?: (state: SyncState) => void,
): void {
  onStatusBarUpdate?.(state);
  for (const listener of listeners) {
    listener(state);
  }
}

export function emitSyncProgress(
  listeners: Set<(current: number, total: number) => void>,
  current: number,
  total: number,
  options?: {
    onStatusBarProgress?: (current: number, total: number) => void;
    onExternalProgress?: (current: number, total: number) => void;
  },
): void {
  options?.onStatusBarProgress?.(current, total);
  options?.onExternalProgress?.(current, total);
  for (const listener of listeners) {
    listener(current, total);
  }
}
