const listeners = new Set<(token: string) => void>();
export const SESSION_RECOVERY_MESSAGE = 'Session expired. Pending changes and drafts are kept on this device. Reconnect to their original vault to recover them.';
/** Report only the rejected credential; the app decides whether it still owns it. */
export function reportExpiredConnection(token: string): void { for (const listener of listeners) listener(token); }
export function onConnectionExpired(listener: (token: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
