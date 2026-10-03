import { decryptJson } from '../encryption/envelope';
import { FileKeyAuthority } from '../encryption/file-authority';
import type { VaultKeyBundle } from '../encryption/key-bundle';
import { reminderRequestHash } from '../encryption/reminder-receipt';
import { computeHash } from '../sync/hasher';
import type { CaptureRecord } from './data/capture-outbox';

export interface CaptureRecoveryReceipt {
  receipts: Array<{ kind: 'reading' | 'reminder'; requestHash: string; envelope?: string; encrypted?: string }>;
  retryValid: boolean;
}

/** Authenticate both the original intent and the exact ciphertext dispatched by
 * an older client. A conversion may have wrapped that receipt a second time. */
export async function recoverCaptureReceipt(record: CaptureRecord, saved: CaptureRecoveryReceipt, keys: VaultKeyBundle, attempt?: { requestHash: string; body: string }): Promise<string | undefined> {
  if (!Array.isArray(saved.receipts) || saved.receipts.length > 1) throw new Error('The pending Reading save has conflicting receipts. Its original file is preserved.');
  const row = saved.receipts[0];
  if (!row) {
    if (saved.retryValid !== true) throw new Error('This pending Reading save is too old to retry safely. Its original file is preserved.');
    return;
  }
  const hash = await computeHash(new TextEncoder().encode(JSON.stringify({ action: 'capture', body: record.body })).buffer);
  const authority = await FileKeyAuthority.fromVault(keys), root = authority.forVaultMetadata();
  const context = { vaultId: keys.vaultId, scopeId: 'vault', objectId: record.body.operationId, purpose: 'reminder' as const };
  let receipt = row.envelope ? await decryptJson(row.envelope, root.key, context) as { requestHash: string; response: { encrypted?: string; id?: string } } : undefined;
  // Conversion deliberately replaces the public request hash with a marker;
  // the original hash survives only inside the authenticated vault envelope.
  const requestHash = receipt?.requestHash ?? row.requestHash;
  if (row.kind === 'reminder') {
    if (attempt && (attempt.requestHash !== hash || requestHash !== await reminderRequestHash('encrypted-files', JSON.parse(attempt.body) as Record<string, unknown>))) throw new Error('The encrypted Reading attempt does not match its receipt.');
    const encrypted = receipt?.response.encrypted ?? row.encrypted;
    receipt = undefined;
    for (const scope of keys.scopes.filter(scope => scope.purpose === 'reading')) {
      try { receipt = await decryptJson(encrypted!, authority.forPriorScope(scope.id, scope.data.id).key, { ...context, scopeId: scope.id }) as NonNullable<typeof receipt>; break; }
      catch { /* Only this vault's known Reading scopes may open the receipt. */ }
    }
  } else if (row.kind !== 'reading') throw new Error('Invalid Reading receipt.');
  if (!receipt || receipt.requestHash !== hash || typeof receipt.response?.id !== 'string') throw new Error('The Reading receipt does not match this saved link.');
  return receipt.response.id;
}
