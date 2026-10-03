const prefix = 'crate-encryption-unlocked:';

/** Presentation only: never use this marker to authorize reads or unlock data. */
export class EncryptionKeyRequiredError extends Error {
  readonly firstUnlock: boolean;
  constructor(vaultId: string) {
    super('Reload Crate to connect with Obsidian or use your recovery key.');
    try { this.firstUnlock = localStorage.getItem(prefix + vaultId) === null; }
    catch { this.firstUnlock = false; }
  }
}

export function rememberEncryptionUnlock(vaultId: string): void {
  try { localStorage.setItem(prefix + vaultId, '1'); }
  catch { /* Optional onboarding history must not prevent access to content. */ }
}
