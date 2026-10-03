import type { EncryptionServerState } from '../../encryption/server-state';

/** Rename authority follows its stable scope. Selecting a different folder
 * changes accessId and revokes the previous capabilities instead. */
export function prepareEncryptionScopeMove(db: D1Database, previous: EncryptionServerState, next: EncryptionServerState): D1PreparedStatement[] {
  const moves = previous.scopes.flatMap(scope => {
    const target = next.scopes.find(candidate => candidate.id === scope.id)!;
    return target.folderPath === scope.folderPath ? [] : [{ from: scope.folderPath, to: target.folderPath,
      preserve: (scope.accessId ?? scope.id) === (target.accessId ?? target.id) && !!target.binding }];
  });
  const mapping = JSON.stringify(moves);
  const oldFolders = `SELECT json_extract(value, '$.from') FROM json_each(?)`;
  const replaced = `SELECT json_extract(value, '$.from') FROM json_each(?) WHERE NOT json_extract(value, '$.preserve')`;
  const retained = `SELECT json_extract(value, '$.from') FROM json_each(?) WHERE json_extract(value, '$.preserve')`;
  const destination = `(SELECT json_extract(value, '$.to') FROM json_each(?) WHERE json_extract(value, '$.from') = folder_path)`;
  return [
    db.prepare(`UPDATE notification_policy SET folder_path = ${destination}, revision = ? WHERE folder_path IN (${oldFolders})`).bind(mapping, crypto.randomUUID(), mapping),
    db.prepare(`UPDATE reading_policy SET folder_path = ${destination}, generation = CASE WHEN folder_path IN (${replaced}) THEN ? ELSE generation END, revision = ? WHERE folder_path IN (${oldFolders})`).bind(mapping, mapping, crypto.randomUUID(), crypto.randomUUID(), mapping),
    db.prepare(`DELETE FROM push_subscriptions WHERE folder_path IN (${replaced}) OR owner_token_id IN (SELECT id FROM auth_tokens WHERE scope != 'vault' AND folder_path IN (${replaced}))`).bind(mapping, mapping),
    db.prepare(`DELETE FROM auth_tokens WHERE scope != 'vault' AND folder_path IN (${replaced})`).bind(mapping),
    db.prepare(`UPDATE push_subscriptions SET folder_path = ${destination} WHERE folder_path IN (${retained})`).bind(mapping, mapping),
    db.prepare(`UPDATE auth_tokens SET folder_path = ${destination} WHERE scope != 'vault' AND folder_path IN (${retained})`).bind(mapping, mapping),
    db.prepare(`DELETE FROM web_enrollment_tokens WHERE folder_path IN (${oldFolders})`).bind(mapping),
    // Unused setup links still describe the old folder; connected sessions survive.
    db.prepare('DELETE FROM reading_enrollments'),
    db.prepare('DELETE FROM reading_handoffs'),
  ];
}
