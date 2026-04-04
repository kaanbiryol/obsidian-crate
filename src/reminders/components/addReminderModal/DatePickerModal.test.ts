import { describe, expect, it } from 'vitest';
import {
  buildDatePickerDateSelection,
  buildDatePickerTimeSelection,
} from './datePickerSelection';
import { parseReminderDateValue } from '../../utils/reminderDate';

describe('DatePickerModal selection helpers', () => {
  it('preserves date-only selections as local date strings', () => {
    const selection = buildDatePickerDateSelection(
      new Date(2026, 3, 4),
      new Date(2026, 3, 3),
      false,
    );

    expect(selection).toEqual({
      value: '2026-04-04',
      hasTime: false,
    });
  });

  it('preserves the existing time for timed date changes, including midnight', () => {
    const selection = buildDatePickerDateSelection(
      new Date(2026, 3, 4),
      new Date(2026, 3, 3, 0, 0),
      true,
    );

    const parsed = parseReminderDateValue(selection.value, selection.hasTime);
    expect(selection.hasTime).toBe(true);
    expect(parsed?.getHours()).toBe(0);
    expect(parsed?.getMinutes()).toBe(0);
    expect(parsed?.getDate()).toBe(4);
  });

  it('switches to timed values when the user changes the time', () => {
    const selection = buildDatePickerTimeSelection(
      15,
      30,
      new Date(2026, 3, 4),
    );

    const parsed = parseReminderDateValue(selection.value, selection.hasTime);
    expect(selection.hasTime).toBe(true);
    expect(parsed?.getHours()).toBe(15);
    expect(parsed?.getMinutes()).toBe(30);
    expect(parsed?.getDate()).toBe(4);
  });
});
