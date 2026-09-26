/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { rowSql } from '../restore/server-restore';

afterEach(reset);
it('commits restore data and its checkpoint atomically and makes stale replay inert', async () => {
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE maintenance_state (key TEXT PRIMARY KEY, value TEXT)'),
    env.DB.prepare('CREATE TABLE reminder_identities (reminder_id TEXT PRIMARY KEY, created_operation_id TEXT NOT NULL)'),
    env.DB.prepare("INSERT INTO maintenance_state VALUES ('crate_restore_progress','plan:0')"),
  ]);
  const insert = rowSql({ table: 'reminder_identities', columns: ['reminder_id', 'created_operation_id'], values: ['reminder', "operation's-id"] }, 'plan:0');
  const checkpoint = "UPDATE maintenance_state SET value='plan:1' WHERE key='crate_restore_progress' AND value='plan:0'";
  const batch = () => [env.DB.prepare(insert), env.DB.prepare(checkpoint)];
  await expect(env.DB.batch([...batch(), env.DB.prepare("INSERT INTO reminder_identities VALUES ('reminder','duplicate')")])).rejects.toThrow();
  expect((await env.DB.prepare('SELECT * FROM reminder_identities').all()).results).toEqual([]);
  expect((await env.DB.prepare('SELECT value FROM maintenance_state').first())?.value).toBe('plan:0');
  await env.DB.batch(batch());
  await env.DB.batch(batch());
  expect((await env.DB.prepare('SELECT * FROM reminder_identities').all()).results).toEqual([{ reminder_id: 'reminder', created_operation_id: "operation's-id" }]);
  expect((await env.DB.prepare('SELECT value FROM maintenance_state').first())?.value).toBe('plan:1');
});
