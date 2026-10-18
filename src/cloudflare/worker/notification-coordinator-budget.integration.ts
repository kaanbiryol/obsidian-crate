/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { handleNotificationPolicy } from './notification-policy';
import { writeCommittedMarkdownFile } from './storage';
import { runNotificationCoordinator } from './notification-coordinator';

// Delivery runs in its own Durable Object invocation with a separate budget.
vi.mock('./notification-outbox', async original => ({ ...await original<typeof import('./notification-outbox')>(), dispatchNotificationJobs: vi.fn() }));

beforeEach(async () => {
  for (const sql of schema.split(';').map(value => value.trim()).filter(Boolean)) await env.DB.prepare(sql).run();
  await handleNotificationPolicy(new Request('https://test/policy', { method: 'POST', body: JSON.stringify({ folderPath: 'Reminders', timezone: 'UTC', allDayTime: '09:00' }) }), env.DB);
});
afterEach(async () => { await reset(); });

const SETUP_ROWS = new Set(['e2ee:state', 'crate_feature_policy']);

async function countStatements(run: () => Promise<void>): Promise<{ total: number; setup: number }> {
  const prepare = env.DB.prepare.bind(env.DB);
  let total = 0, setup = 0;
  env.DB.prepare = (sql: string) => {
    total += 1;
    if (sql.includes('FROM notification_policy WHERE id = 1')) setup += 1;
    const statement = prepare(sql);
    const bind = statement.bind.bind(statement);
    statement.bind = (...args: unknown[]) => {
      if (/^SELECT value FROM maintenance_state WHERE key ?= ?\?$/.test(sql) && SETUP_ROWS.has(String(args[0]))) setup += 1;
      return bind(...args);
    };
    return statement;
  };
  try { await run(); } finally { env.DB.prepare = prepare; }
  return { total, setup };
}

it('reads encryption, feature and notification settings once per coordinator run', async () => {
  await writeCommittedMarkdownFile(env.BUCKET, env.DB, 'Reminders/Inbox.md', `- [ ] Task 2099-01-01T12:00:00.000Z <!-- crate-id:${crypto.randomUUID()} -->`, null);
  const state = { storage: { setAlarm: vi.fn(async () => {}) } } as unknown as DurableObjectState;
  // Before: 31 statements with 8 setup reads, then 16 with 7.
  expect(await countStatements(() => runNotificationCoordinator(state, env))).toEqual({ total: 26, setup: 3 });
  expect(await countStatements(() => runNotificationCoordinator(state, env))).toEqual({ total: 12, setup: 3 });
  expect(await env.DB.prepare('SELECT COUNT(*) AS jobs FROM notification_jobs').first()).toEqual({ jobs: 1 });
});
