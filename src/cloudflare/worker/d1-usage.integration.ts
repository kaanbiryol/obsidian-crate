/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { meterD1Usage, withD1Usage } from './d1-usage';
import { parseD1Usage, D1_USAGE_HEADER } from '@/protocol/d1-usage';

afterEach(reset);
it('counts first, all, run and batch metadata without reexecuting statements', async () => {
  await env.DB.prepare('CREATE TABLE measured(id TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID').run();
  const meter = meterD1Usage(env.DB);
  await meter.db.prepare("INSERT INTO measured VALUES ('a', 'one')").run();
  await meter.db.batch([meter.db.prepare("INSERT INTO measured VALUES ('b', 'two')"), meter.db.prepare("INSERT INTO measured VALUES ('c', 'three')")]);
  expect(await meter.db.prepare('SELECT value FROM measured WHERE id = ?').bind('a').first()).toEqual({ value: 'one' });
  expect(await meter.db.prepare("SELECT value FROM measured WHERE id = 'missing'").first()).toBeNull();
  expect((await meter.db.prepare('SELECT id FROM measured').all()).results).toHaveLength(3);
  expect(meter.usage).toEqual({ rowsRead: 4, rowsWritten: 3, complete: true });
  await expect(meter.db.prepare("INSERT INTO measured VALUES ('a', 'duplicate')").run()).rejects.toThrow();
  expect(meter.usage).toMatchObject({ rowsWritten: 3, complete: false });
});

it('includes a forwarded response exactly once and keeps concurrent invocation meters separate', async () => {
  const measuredEnv = { ...env, REMINDER_ALARMS: {
    idFromName: () => ({}), get: () => ({ fetch: async () => new Response('forwarded', { headers: { [D1_USAGE_HEADER]: '11:7:1' } }) }),
  } };
  const response = await withD1Usage(measuredEnv, async e => {
    await e.DB.prepare('SELECT 1').first();
    return e.REMINDER_ALARMS.get(e.REMINDER_ALARMS.idFromName('test')).fetch('https://do');
  });
  expect(parseD1Usage(response.headers.get(D1_USAGE_HEADER))).toEqual({ rowsRead: 11, rowsWritten: 7, complete: true });
  const other = await withD1Usage(env, async () => new Response('idle'));
  expect(parseD1Usage(other.headers.get(D1_USAGE_HEADER))).toEqual({ rowsRead: 0, rowsWritten: 0, complete: true });
});
