import { decodeBase64Url, encodeBase64Url } from './encoding';
import { validateReminderKeyGrant, type ReminderKeyGrant } from './key-bundle';

const PREFIX = 'crate-web-key-v1.';

function validate(grants: unknown): asserts grants is ReminderKeyGrant[] {
  if (!Array.isArray(grants) || grants.length < 1 || grants.length > 2) throw new Error('Invalid web app key');
  const checked = (grants as unknown[]).map(grant => { validateReminderKeyGrant(grant); return grant; });
  const first = checked[0]!;
  const purposes = new Set(), ids = new Set(), secrets = new Set();
  for (const grant of checked) {
    if (grant.vaultId !== first.vaultId || grant.generation !== first.generation || purposes.has(grant.scope.purpose)) throw new Error('Web app keys must belong to the same vault and different features');
    purposes.add(grant.scope.purpose);
    for (const key of [grant.scope.data, grant.scope.notifications]) {
      if (ids.has(key.id) || secrets.has(key.secret)) throw new Error('Web app folders must keep separate encryption keys');
      ids.add(key.id); secrets.add(key.secret);
    }
  }
  const second = checked[1];
  if (second && (first.scope.id === second.scope.id || first.scope.folderPath === second.scope.folderPath
    || first.scope.folderPath.startsWith(second.scope.folderPath + '/') || second.scope.folderPath.startsWith(first.scope.folderPath + '/'))) throw new Error('Web app folders must be separate');
}

/** Contains only the selected folder grants, never the full vault/recovery key. */
export function encodeWebAppKey(grants: ReminderKeyGrant[]): string {
  validate(grants);
  return PREFIX + encodeBase64Url(new TextEncoder().encode(JSON.stringify(grants)));
}

export function decodeWebAppKey(code: string): ReminderKeyGrant[] {
  const value = code.trim();
  if (!value.startsWith(PREFIX)) throw new Error('Paste the web app key from Crate in Obsidian');
  const grants: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(value.slice(PREFIX.length), 8192)));
  validate(grants);
  return grants;
}
