import { getLocalTimeZone } from '@internationalized/date';
import { describe, expect, it } from 'vitest';
import { parseRecurrenceFromContent } from './recurrenceParser';
import { recurrenceToText } from './rruleConverter';

describe('parseRecurrenceFromContent', () => {
  it.each([
    ['every Monday to Friday 09:00', { frequency: 'weekly', daysOfWeek: [1, 2, 3, 4, 5] }],
    ['every week Monday-Friday 09:00', { frequency: 'weekly', daysOfWeek: [1, 2, 3, 4, 5] }],
    ['weekly on Fri through Mon 09:00', { frequency: 'weekly', daysOfWeek: [0, 1, 5, 6] }],
    ['every Mon–Wed and Fri 09:00', { frequency: 'weekly', daysOfWeek: [1, 2, 3, 5] }],
    ['every Mon—Wed, Wed, and Friday 09:00', { frequency: 'weekly', daysOfWeek: [1, 2, 3, 5] }],
    ['every 2 weeks on Mon until Wed 09:00', { frequency: 'weekly', interval: 2, daysOfWeek: [1, 2, 3] }],
    ['every Mondays to Mondays 09:00', { frequency: 'weekly', daysOfWeek: [1] }],
    ['every weekend 09:00', { frequency: 'weekly', daysOfWeek: [0, 6] }],
    ['every weekends 09:00', { frequency: 'weekly', daysOfWeek: [0, 6] }],
    ['weekly on weekends 09:00', { frequency: 'weekly', daysOfWeek: [0, 6] }],
    ['every weekday and Saturday 09:00', { frequency: 'weekly', daysOfWeek: [1, 2, 3, 4, 5, 6] }],
    ['every weekend and Monday 09:00', { frequency: 'weekly', daysOfWeek: [0, 1, 6] }],
    ['every weekday 09:00', { frequency: 'weekly', daysOfWeek: [1, 2, 3, 4, 5] }],
    ['every weekdays 09:00', { frequency: 'weekly', daysOfWeek: [1, 2, 3, 4, 5] }],
    ['weekly on weekdays 09:00', { frequency: 'weekly', daysOfWeek: [1, 2, 3, 4, 5] }],
    ['every other Monday 09:00', { frequency: 'weekly', interval: 2, daysOfWeek: [1] }],
    ['every Tuesdays 09:00', { frequency: 'weekly', daysOfWeek: [2] }],
    ['every Tues, Wed and Thurs 09:00', { frequency: 'weekly', daysOfWeek: [2, 3, 4] }],
    ['every Thur-Sat 09:00', { frequency: 'weekly', daysOfWeek: [4, 5, 6] }],
    ['EVERY THURS 09:00', { frequency: 'weekly', daysOfWeek: [4] }],
    ['every Mondays and Fridays 09:00', { frequency: 'weekly', daysOfWeek: [1, 5] }],
    ['every 2 Tuesdays 09:00', { frequency: 'weekly', interval: 2, daysOfWeek: [2] }],
    ['EVERY OTHER WEEK ON MONDAYS 09:00', { frequency: 'weekly', interval: 2, daysOfWeek: [1] }],
    ['every other day 09:00', { frequency: 'daily', interval: 2 }],
    ['every other month on the 15th 09:00', { frequency: 'monthly', interval: 2, dayOfMonth: 15 }],
  ])('recognizes the complete recurring phrase: %s', (text, rule) => {
    const parsed = parseRecurrenceFromContent(`Task ${text} tail`);
    expect(parsed).toMatchObject({ matched: text, rule: { ...rule, hour: 9, minute: 0 } });
    expect(parseRecurrenceFromContent(recurrenceToText(parsed!.rule))?.rule).toEqual(parsed!.rule);
  });

  it.each([
    'every week Monday 09:00',
    'every week on Monday 09:00',
    'weekly Monday 09:00',
    'weekly on Monday at 09:00',
    'EVERY\u00a0WEEK\u00a0MONDAY\u00a009:00',
  ])('parses the entire weekly schedule: %s', text => {
    expect(parseRecurrenceFromContent(`Task ${text} tail`)).toMatchObject({
      matched: text,
      rule: { frequency: 'weekly', daysOfWeek: [1], hour: 9, minute: 0 },
    });
  });

  it.each([
    'every 2 weeks Mon, Wed, and Fri at 09:00',
    'every 2 weeks on Monday, Wednesday and Friday 09:00',
  ])('keeps all weekdays and the interval: %s', text => {
    expect(parseRecurrenceFromContent(text)).toMatchObject({
      matched: text,
      rule: { frequency: 'weekly', interval: 2, daysOfWeek: [1, 3, 5], hour: 9, minute: 0 },
    });
  });

  it.each([
    ['daily at 09:00', 9, 0],
    ['daily at 9', 9, 0],
    ['daily at 9 pm', 21, 0],
    ['every Monday at noon', 12, 0],
    ['every Monday noon', 12, 0],
    ['daily at midnight', 0, 0],
    ['weekly on Mon, Wed at NOON', 12, 0],
    ['monthly on the 1st at midnight', 0, 0],
    ['every day 9am', 9, 0],
    ['every Monday at 9:30 PM', 21, 30],
    ['weekly on Monday 12am', 0, 0],
    ['monthly on the 1st at 12:00 pm', 12, 0],
    ['every 2 months on the 15th at 9pm', 21, 0],
  ])('includes the time in the recurrence: %s', (text, hour, minute) => {
    expect(parseRecurrenceFromContent(text)).toMatchObject({ matched: text, rule: { hour, minute } });
  });

  it.each(['every Monday and review', 'every Monday, review', 'every Monday to review', 'every Monday through review'])('leaves unfinished weekday separators as prose: %s', text => {
    expect(parseRecurrenceFromContent(text)?.matched).toBe('every Monday');
  });

  it.each(['every MondayTuesday', 'every MonandWed', 'every 0 weeks', 'every 0 days'])('does not invent a recurrence from %s', text => {
    expect(parseRecurrenceFromContent(text)).toBeNull();
  });

  it.each(['0', '32', '315'])('rejects an invalid monthly day: %s', day => {
    const result = parseRecurrenceFromContent(`monthly on the ${day}th`);
    expect(result).toBeNull();
  });

  it('skips invalid intervals without hiding later valid schedules', () => {
    expect(parseRecurrenceFromContent('every 0 weeks then every 2 weeks on Mon 09:00')).toMatchObject({
      matched: 'every 2 weeks on Mon 09:00', rule: { interval: 2, daysOfWeek: [1], hour: 9 },
    });
  });

  it('parses daily recurrence with time and timezone', () => {
    const result = parseRecurrenceFromContent('review inbox daily 15:00');

    expect(result?.matched).toBe('daily 15:00');
    expect(result?.rule).toMatchObject({
      frequency: 'daily',
      hour: 15,
      minute: 0,
      timezone: getLocalTimeZone(),
    });
  });

  it('parses interval recurrence', () => {
    const result = parseRecurrenceFromContent('backup every 2 weeks 09:30');

    expect(result?.matched).toBe('every 2 weeks 09:30');
    expect(result?.rule).toMatchObject({
      frequency: 'weekly',
      interval: 2,
      hour: 9,
      minute: 30,
    });
  });

  it('parses monthly recurrence with ordinal day', () => {
    const result = parseRecurrenceFromContent('pay rent monthly on the 1st');

    expect(result?.matched).toBe('monthly on the 1st');
    expect(result?.rule).toMatchObject({
      frequency: 'monthly',
      dayOfMonth: 1,
    });
  });

  it('parses and sorts multiple weekdays', () => {
    const result = parseRecurrenceFromContent('standup every Fri, Mon and Wed 10:00');

    expect(result?.matched).toBe('every Fri, Mon and Wed 10:00');
    expect(result?.rule).toMatchObject({
      frequency: 'weekly',
      daysOfWeek: [1, 3, 5],
      hour: 10,
      minute: 0,
    });
  });

  it('round trips a weekly interval with selected days', () => {
    const text = recurrenceToText({
      frequency: 'weekly',
      interval: 2,
      daysOfWeek: [1, 3],
      hour: 9,
      minute: 0,
    });
    const result = parseRecurrenceFromContent(text);

    expect(text).toBe('every 2 weeks on Mon, Wed 09:00');
    expect(result?.matched).toBe(text);
    expect(result?.rule).toMatchObject({
      frequency: 'weekly',
      interval: 2,
      daysOfWeek: [1, 3],
      hour: 9,
      minute: 0,
    });
  });

  it('round trips a monthly interval with its month day', () => {
    const text = recurrenceToText({
      frequency: 'monthly',
      interval: 2,
      dayOfMonth: 15,
      hour: 9,
      minute: 0,
    });
    const result = parseRecurrenceFromContent(text);

    expect(text).toBe('every 2 months on the 15th 09:00');
    expect(result?.matched).toBe(text);
    expect(result?.rule).toMatchObject({
      frequency: 'monthly',
      interval: 2,
      dayOfMonth: 15,
      hour: 9,
      minute: 0,
    });
  });

  it('returns null when no recurrence pattern is present', () => {
    expect(parseRecurrenceFromContent('review next monday')).toBeNull();
  });
});
