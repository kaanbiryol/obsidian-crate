const listeners = new Set<() => void>();
export function onReadingEncryptionReset(listener: () => void): void { listeners.add(listener); }
/** Synchronous logout without loading Reading or its crypto implementation. */
export function resetReadingEncryption(): void { for (const listener of listeners) listener(); }
