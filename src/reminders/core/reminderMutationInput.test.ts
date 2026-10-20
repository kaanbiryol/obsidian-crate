import { expect, it } from 'vitest';
import { parseReminderRecurrenceInput, parseReminderUpdateParams, ReminderInputError } from './reminderMutationInput';

it('keeps omitted fields and clears explicit nulls in an edit body', () => {
	expect(parseReminderUpdateParams({ id: 'r1', content: ' Renamed ' })).toEqual({ content: 'Renamed' });
	expect(parseReminderUpdateParams({ description: null, dueDate: null, dueDatetime: '', recurrence: null, project: '' }))
		.toEqual({ description: '', dueDate: undefined, dueDatetime: undefined, recurrence: null });
	expect(parseReminderUpdateParams({ priority: 1, project: ' Work/Home ', description: ' Notes ' }))
		.toEqual({ priority: 1, project: 'Work/Home', description: 'Notes' });
});

it('rejects invalid edit fields with the field that failed', () => {
	expect(() => parseReminderUpdateParams({ priority: 3 })).toThrow(expect.objectContaining({ field: 'priority' }));
	expect(() => parseReminderUpdateParams({ project: '../Secrets' })).toThrow(expect.objectContaining({ field: 'project' }));
	expect(() => parseReminderUpdateParams({ recurrence: { frequency: 'hourly' } }))
		.toThrow(new ReminderInputError('recurrence', 'Invalid recurrence frequency'));
});

it('distinguishes a kept, removed and replaced repeat', () => {
	expect(parseReminderRecurrenceInput(undefined)).toBeUndefined();
	expect(parseReminderRecurrenceInput(null)).toBeNull();
	expect(parseReminderRecurrenceInput({ frequency: 'weekly', daysOfWeek: [3, 1, 3] })).toMatchObject({ frequency: 'weekly', daysOfWeek: [1, 3] });
});
