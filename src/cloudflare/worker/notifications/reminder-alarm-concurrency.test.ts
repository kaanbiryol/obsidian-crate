import { afterEach, expect, it, vi } from 'vitest';
import { ReminderAlarm } from './reminder-alarm';
import { listPushSubscriptionIds, sendToAllSubscriptions } from './push';
vi.mock('./push', () => ({ listPushSubscriptionIds: vi.fn(), sendToAllSubscriptions: vi.fn() }));
afterEach(() => vi.resetAllMocks());
  it.each([false, true])('an old alarm cannot mark or retry a new schedule (failed=%s)', async failed => {
    vi.mocked(listPushSubscriptionIds).mockResolvedValue(['subscription']);
    let resolveDelivery!: (value: unknown) => void;
    let started!: () => void;
    const sending = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(sendToAllSubscriptions).mockImplementationOnce(async () => {
      started();
      return await new Promise(resolve => { resolveDelivery = resolve; });
    });
    const old = { reminderId: 'audit-id', scheduleToken: 'old', content: 'old title', dueDatetime: '2099-01-01T00:00:00.000Z' };
    const values = new Map<string, unknown>([['reminder', old]]);
    let schedule = { schedule_token: old.scheduleToken, content: old.content, due_datetime: old.dueDatetime, project: null };
    const state = { storage: {
      get: async (key: string) => values.get(key), put: async (key: string, value: unknown) => { values.set(key, value); },
      delete: async (key: string) => values.delete(key), deleteAll: async () => values.clear(),
      getAlarm: async () => Date.parse(old.dueDatetime), setAlarm: async () => {}, deleteAlarm: async () => {},
    }};
    const db = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({
      first: async () => schedule,
      run: async () => { if (sql.includes('INSERT OR REPLACE')) schedule = { schedule_token: String(args[1]), content: String(args[2]), due_datetime: String(args[4]), project: null }; },
    }) }) };
    const alarm = new ReminderAlarm(state as never, { DB: db as never });
    const oldDelivery = alarm.alarm();
    await sending;
    expect((await alarm.fetch(new Request('https://do/schedule', { method: 'PUT', body: JSON.stringify({ reminderId: 'audit-id', content: 'new title', dueDatetime: '2099-02-01T00:00:00.000Z' }) }))).status).toBe(200);
    resolveDelivery({ sent: failed ? 0 : 1, failed: failed ? 1 : 0, pruned: 0, quarantined: 0, errors: [], failedSubscriptionIds: [] });
    await oldDelivery;
    expect(values.get('reminder')).toMatchObject({ content: 'new title' });
    expect(values.get('deliveryComplete')).toBeUndefined();
    expect(values.get('retryAttempt')).toBeUndefined();
    vi.mocked(sendToAllSubscriptions).mockResolvedValue({ sent: 1, failed: 0, pruned: 0, quarantined: 0, errors: [], failedSubscriptionIds: [] });
    await alarm.alarm();
    expect(sendToAllSubscriptions).toHaveBeenCalledTimes(2);
    expect(values.has('reminder')).toBe(false);
  });
