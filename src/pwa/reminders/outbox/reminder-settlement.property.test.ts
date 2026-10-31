import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyReminderSettlement } from './reminder-settlement';
import type { ReminderRecord } from '../types';

type Settlement = Parameters<typeof applyReminderSettlement>[2];

const ids = ['a', 'b', 'c', 'd', 'e'];
const revision = fc.constantFrom('r0', 'r1', 'r2');
const project = fc.constantFrom('Inbox', 'Work');
const record = (id: string) => fc.record({ revision, project, completed: fc.boolean(), lineNumber: fc.nat({ max: 20 }) })
	.map((fields): ReminderRecord => ({ id, content: `Task ${id}`, priority: 4, filePath: `Reminders/${fields.project}.md`, ...fields }));
const list = fc.subarray(ids).chain(present => fc.tuple(...present.map(record)))
	.chain(reminders => fc.shuffledSubarray(reminders, { minLength: reminders.length, maxLength: reminders.length }));

/** Settlements whose base usually, but not always, matches the list. */
function settlement(reminders: ReminderRecord[]): fc.Arbitrary<Settlement> {
	const recordId = fc.constantFrom(...ids);
	const base = (id: string) => fc.oneof(
		fc.constant(reminders.find(item => item.id === id)?.revision),
		fc.option(revision, { nil: undefined }),
	);
	const recordChange = recordId.chain(id => fc.record({
		kind: fc.constantFrom('save' as const, 'complete' as const),
		previousRevision: base(id),
		reminder: record(id).map(item => ({ ...item, revision: `confirmed-${item.revision}` })),
	}).map((fields): Settlement => ({ version: 1, operationId: 'op', recordId: id, ...fields })));
	const deletion = recordId.chain(id => base(id).map((previousRevision): Settlement =>
		({ version: 1, operationId: 'op', kind: 'delete', recordId: id, previousRevision })));
	const reorder = project.chain(name => {
		const current = reminders.filter(item => item.project === name).map(item => item.id);
		return fc.record({
			orderedIds: fc.shuffledSubarray(current, { minLength: current.length, maxLength: current.length }),
			expectedOrder: fc.oneof(fc.constant(current), fc.shuffledSubarray(ids)),
		}).map((fields): Settlement => ({ version: 1, operationId: 'op', kind: 'reorder', project: name, ...fields }));
	});
	return fc.oneof(recordChange, deletion, reorder);
}

const scenario = list.chain(reminders => fc.tuple(fc.constant(reminders), settlement(reminders)));

describe('confirmed change settlement between tabs', () => {
	it('is a no-op when the same packet is delivered again', () => {
		fc.assert(fc.property(scenario, ([reminders, settled]) => {
			const first = applyReminderSettlement(reminders, ['Inbox', 'Work'], settled);
			if (!first) return;
			const again = applyReminderSettlement(first.reminders, first.projects, settled);
			if (again) expect(again).toEqual(first);
		}), { numRuns: 400 });
	});

	it('never applies over a base revision other than the one the command was sent with', () => {
		fc.assert(fc.property(scenario, ([reminders, settled]) => {
			fc.pre(settled.kind !== 'reorder');
			const current = reminders.find(item => item.id === settled.recordId);
			const stale = current ? current.revision !== settled.previousRevision || !settled.previousRevision : settled.previousRevision !== undefined;
			if (stale) expect(applyReminderSettlement(reminders, ['Inbox', 'Work'], settled)).toBeNull();
		}), { numRuns: 400 });
	});

	it('touches only the settled record and never duplicates an id', () => {
		fc.assert(fc.property(scenario, ([reminders, settled]) => {
			fc.pre(settled.kind !== 'reorder');
			const result = applyReminderSettlement(reminders, ['Inbox', 'Work'], settled);
			if (!result) return;
			const resultIds = result.reminders.map(item => item.id);
			expect(new Set(resultIds).size).toBe(resultIds.length);
			const others = (items: ReminderRecord[]) => items.filter(item => item.id !== settled.recordId);
			expect(others(result.reminders)).toEqual(others(reminders));
			const target = result.reminders.find(item => item.id === settled.recordId);
			expect(target).toEqual(settled.kind === 'delete' ? undefined : settled.reminder);
		}), { numRuns: 400 });
	});

	it('a reorder only permutes active records of its project within their own slots', () => {
		fc.assert(fc.property(scenario, ([reminders, settled]) => {
			fc.pre(settled.kind === 'reorder');
			const result = applyReminderSettlement(reminders, ['Inbox', 'Work'], settled);
			if (!result) return;
			expect(result.reminders).toHaveLength(reminders.length);
			const moved = (item: ReminderRecord) => item.project === settled.project && !item.completed;
			reminders.forEach((item, index) => {
				const after = result.reminders[index]!;
				if (!moved(item)) expect(after).toBe(item);
				else {
					expect(moved(after)).toBe(true);
					expect(after.lineNumber).toBe(item.lineNumber);
				}
			});
			const withoutLine = (items: ReminderRecord[]) => items.filter(moved).map(({ lineNumber: _line, ...rest }) => rest)
				.sort((a, b) => a.id.localeCompare(b.id));
			expect(withoutLine(result.reminders)).toEqual(withoutLine(reminders));
		}), { numRuns: 400 });
	});
});
