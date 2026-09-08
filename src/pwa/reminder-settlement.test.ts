import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyReminderSettlement, createReminderSettlementChannel } from './reminder-settlement';
import type { PendingReminderChange, ReminderChangeResult } from './reminder-outbox-types';
import type { ReminderRecord } from './types';

const before: ReminderRecord = { id: 'one', content: 'Before', revision: 'before', project: 'Inbox',
	filePath: 'Reminders/Inbox.md', priority: 4, completed: false };
const after: ReminderRecord = { ...before, revision: 'after', content: 'After' };
let events: Array<{ key: string; newValue: string | null }>;
let entries: Map<string, string>;

beforeEach(() => {
	entries = new Map(); events = [];
	vi.stubGlobal('localStorage', {
		setItem: (key: string, value: string) => { entries.set(key, value); events.push({ key, newValue: value }); },
		removeItem: (key: string) => { entries.delete(key); events.push({ key, newValue: null }); },
	});
});
afterEach(() => vi.unstubAllGlobals());

function change(kind: PendingReminderChange['kind'], update: Partial<PendingReminderChange> = {}): PendingReminderChange {
	return { kind, operationId: crypto.randomUUID(), recordId: before.id, previous: before,
		path: '/reminders/update', method: 'POST', body: JSON.stringify({ expectedRevision: before.revision }),
		status: 'pending', attempts: 0, retryAt: 0, ...update };
}

describe('confirmed reminder changes between tabs', () => {
	it('publishes before removal, retains no payload, and isolates the token and exact folder', async () => {
		const sender = await createReminderSettlementChannel('secret', 'Reminders');
		const peer = await createReminderSettlementChannel('secret', 'Reminders');
		const renewed = await createReminderSettlementChannel('new secret', 'Reminders');
		const otherFolder = await createReminderSettlementChannel('secret', 'Reminders/Other');
		sender.publish(change('save'), { reminder: after });
		expect(entries.size).toBe(0);
		expect(sender.key).not.toContain('secret');
		expect(events[1]).toEqual({ key: sender.key, newValue: null });
		expect(renewed.read(events[0]!)).toBeNull();
		expect(otherFolder.read(events[0]!)).toBeNull();
		expect(applyReminderSettlement([before], ['Inbox'], peer.read(events[0]!)!)).toEqual({ reminders: [after], projects: ['Inbox'] });
	});

	it.each(['save', 'complete', 'delete', 'reorder'] as const)('converges a confirmed %s without replaying its command', async kind => {
		const channel = await createReminderSettlementChannel('secret', 'Reminders');
		const second = { ...before, id: 'two' };
		const completed = { ...before, id: 'done', completed: true };
		const changed = kind === 'complete' ? { ...after, completed: true } : after;
		const result: ReminderChangeResult = kind === 'save' || kind === 'complete' ? { reminder: changed } : {};
		const reorder = kind === 'reorder' ? { project: 'Inbox', orderedIds: ['two', 'one'], body: JSON.stringify({ expectedOrder: ['one', 'two', 'done'] }) } : {};
		channel.publish(change(kind, reorder), result);
		const merged = applyReminderSettlement([before, second, completed], ['Inbox'], channel.read(events[0]!)!);
		expect(merged?.reminders).toEqual(kind === 'delete' ? [second, completed] : kind === 'reorder' ? [second, before, completed] : [changed, second, completed]);
	});

	it('adds a creation and its project but never replaces a newer base with a delayed result', async () => {
		const channel = await createReminderSettlementChannel('secret', 'Reminders');
		const created = { ...after, project: 'New', filePath: 'Reminders/New.md' };
		channel.publish(change('save', { body: '{}', previous: undefined }), { reminder: created });
		const packet = channel.read(events[0]!)!;
		expect(applyReminderSettlement([], ['Inbox'], packet)).toEqual({ reminders: [created], projects: ['Inbox', 'New'] });
		expect(applyReminderSettlement([{ ...created, revision: 'newer' }], ['Inbox'], packet)).toBeNull();
		channel.publish(change('save'), { reminder: after });
		expect(applyReminderSettlement([{ ...before, revision: 'newer' }], ['Inbox'], channel.read(events[2]!)!)).toBeNull();
	});

	it('rejects malformed or cross-folder packets and stale reorder bases', async () => {
		const channel = await createReminderSettlementChannel('secret', 'Reminders');
		expect(channel.read({ key: channel.key, newValue: 'broken' })).toBeNull();
		channel.publish(change('save'), { reminder: { ...after, filePath: 'Other/Inbox.md' } });
		expect(channel.read(events[0]!)).toBeNull();
		channel.publish(change('reorder', { project: 'Inbox', orderedIds: ['two', 'one'], body: JSON.stringify({ expectedOrder: ['one', 'two'] }) }), {});
		expect(applyReminderSettlement([before], ['Inbox'], channel.read(events[2]!)!)).toBeNull();
	});

	it('does not acknowledge publication when browser storage fails', async () => {
		const channel = await createReminderSettlementChannel('secret', 'Reminders');
		vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded'); });
		expect(() => channel.publish(change('save'), { reminder: after })).toThrow('Could not share the confirmed change');
	});
});
