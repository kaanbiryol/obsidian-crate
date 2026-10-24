const listeners = new Set<(discardKeys: boolean) => void>();
export function onReadingEncryptionReset(listener: (discardKeys: boolean) => void): void { listeners.add(listener); }
/** Synchronous logout without loading Reading or its crypto implementation.
 * A key or capture from this page's link survives sign-in unless discarded. */
export function resetReadingEncryption(discardKeys = false): void { for (const listener of listeners) listener(discardKeys); }
