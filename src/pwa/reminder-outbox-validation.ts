import * as v from 'valibot';
import type { PendingReminderChange } from './reminder-outbox-types';
import { isStoredReminderDraft, isStoredReminderRecord, storedObject, storedStringChoice } from './reminder-storage-validation';

export const OPERATION_ID = /^[a-zA-Z0-9_-]{16,128}$/;
const operationIdSchema = v.pipe(v.string(), v.check(value => OPERATION_ID.test(value)));
const nonNegativeNumber = v.pipe(v.number(), v.check(value => Number.isFinite(value) && value >= 0));
const common = {
	operationId: operationIdSchema,
	status: storedStringChoice(['pending', 'uncertain', 'failed']),
	attempts: v.pipe(nonNegativeNumber, v.check(value => Number.isSafeInteger(value))),
	retryAt: nonNegativeNumber,
	ambiguous: v.optional(v.boolean()),
	reviewRequired: v.optional(v.boolean()),
	body: v.string(),
	error: v.optional(v.string()),
};
const recordFields = {
	recordId: v.pipe(v.string(), v.check(value => value.length > 0)),
	modal: v.optional(storedObject({
		draft: v.custom(isStoredReminderDraft),
		mode: storedStringChoice(['create', 'edit']),
	})),
};
const noFollowUp = v.optional(v.never());
const changeSchema = v.variant('kind', [
	v.object({ ...common, ...recordFields, kind: v.literal('save'), method: v.literal('POST'),
		path: storedStringChoice(['/reminders/create', '/reminders/update']),
		followUp: v.optional(storedObject({ operationId: operationIdSchema,
			input: storedObject({ folderPath: v.string(), content: v.string(), project: v.string() }),
		})),
	}),
	v.object({ ...common, ...recordFields, kind: v.literal('complete'), method: v.literal('POST'),
		path: v.literal('/reminders/set-completed'), followUp: noFollowUp }),
	v.object({ ...common, ...recordFields, kind: v.literal('delete'), method: v.literal('DELETE'),
		path: v.literal('/reminders/delete'), followUp: noFollowUp }),
	v.object({ ...common, kind: v.literal('reorder'), method: v.literal('POST'),
		path: v.literal('/reminders/reorder'), project: v.string(), orderedIds: v.array(v.string()), followUp: noFollowUp }),
]);
const bodySchema = storedObject({ operationId: v.string(), folderPath: v.string() });
const saveBodySchema = storedObject({ content: v.string(), project: v.string() });
const completeBodySchema = storedObject({ completed: v.boolean() });
const reorderBodySchema = storedObject({ expectedOrder: v.array(v.string()) });

export const storedChangeSchema = storedObject({ version: v.literal(1), createdAt: nonNegativeNumber, change: v.unknown() });

/** Validate in place: request bytes and unrecognized metadata belong to the saved attempt. */
export function isStoredReminderChange(value: unknown, operationId: string, folderPath: string): value is PendingReminderChange {
	if (Array.isArray(value) || !v.is(changeSchema, value) || value.operationId !== operationId
		|| (value.reviewRequired === true && (value.status !== 'failed' || value.ambiguous !== true))) return false;
	let body: unknown;
	try { body = JSON.parse(value.body); } catch { return false; }
	if (!v.is(bodySchema, body) || body.operationId !== operationId || body.folderPath !== folderPath) return false;
	if (value.followUp !== undefined && (value.followUp.operationId === operationId || value.followUp.input.folderPath !== folderPath)) return false;
	// Use the original object, not a parsed schema output that could strip unknown fields.
	const change = value as PendingReminderChange;
	const request = body as Record<string, unknown>;
	if (value.kind === 'reorder') return v.is(reorderBodySchema, body) && request.project === value.project
		&& JSON.stringify(request.orderedIds) === JSON.stringify(value.orderedIds);
	if (request.id !== value.recordId) return false;
	for (const record of [change.optimistic, change.previous]) {
		if (record !== undefined && (!isStoredReminderRecord(record, folderPath) || record.id !== value.recordId)) return false;
	}
	if (value.kind === 'save') return v.is(saveBodySchema, body);
	return value.kind === 'delete' || v.is(completeBodySchema, body);
}
