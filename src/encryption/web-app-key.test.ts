import { expect, it } from 'vitest';
import { addReminderScope, createVaultKeyBundle, createReminderKeyGrant } from './key-bundle';
import { decodeBase64Url, encodeBase64Url } from './encoding';
import { decodeWebAppKey, encodeWebAppKey } from './web-app-key';

function fixture() {
  const bundle = addReminderScope(addReminderScope(addReminderScope(createVaultKeyBundle(), 'Reminders'), 'Reading', 'reading'), 'Other');
  const grants = ['Reminders', 'Reading'].map(folder => createReminderKeyGrant(bundle, folder));
  return { bundle, grants };
}
it('round-trips two separate folder keys without serializing the vault or other folder key', () => {
  const { bundle, grants } = fixture();
  const code = encodeWebAppKey(grants), raw = new TextDecoder().decode(decodeBase64Url(code.split('.')[1]!, 8192));
  expect(decodeWebAppKey(` ${code}\n`)).toEqual(grants);
  expect(raw).not.toContain(bundle.vault.secret);
  expect(raw).not.toContain(bundle.scopes[2]!.data.secret);
  expect(grants[0]!.scope.data.secret).not.toBe(grants[1]!.scope.data.secret);
});
it('uses the same web app code format for an enrollment with one feature', () => {
  for (const grant of fixture().grants) expect(decodeWebAppKey(encodeWebAppKey([grant]))).toEqual([grant]);
});
it('rejects the retired individual folder code format', () => {
  const oldCode = 'crate-reminders-key-v1.' + encodeBase64Url(new TextEncoder().encode(JSON.stringify(fixture().grants[0])));
  expect(() => decodeWebAppKey(oldCode)).toThrow('Paste the web app key');
});
it.each(['vault', 'generation', 'feature', 'root key', 'reused secret', 'reused id', 'scope', 'overlap', 'extra'])('rejects invalid bundled authority: %s', change => {
  const { bundle, grants } = fixture();
  if (change === 'vault') grants[1]!.vaultId = crypto.randomUUID();
  if (change === 'generation') grants[1]!.generation++;
  if (change === 'feature') delete grants[1]!.scope.purpose;
  if (change === 'root key') Object.assign(grants[0]!, { vault: bundle.vault });
  if (change === 'reused secret') grants[1]!.scope.data.secret = grants[0]!.scope.data.secret;
  if (change === 'reused id') grants[1]!.scope.data.id = grants[0]!.scope.data.id;
  if (change === 'scope') grants[1]!.scope.id = grants[0]!.scope.id;
  if (change === 'overlap') grants[1]!.scope.folderPath = 'Reminders/Reading';
  if (change === 'extra') grants.push(createReminderKeyGrant(bundle, 'Other'));
  const code = 'crate-web-key-v1.' + encodeBase64Url(new TextEncoder().encode(JSON.stringify(grants)));
  expect(() => encodeWebAppKey(grants)).toThrow();
  expect(() => decodeWebAppKey(code)).toThrow();
});
it('rejects empty, malformed and oversized codes', () => {
  for (const code of ['', 'crate-web-key-v1.e30', 'crate-web-key-v1.W10', 'crate-web-key-v1.' + 'A'.repeat(20000)]) expect(() => decodeWebAppKey(code)).toThrow();
});
