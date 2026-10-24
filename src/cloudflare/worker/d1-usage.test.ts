import { expect, it } from 'vitest';
import { isD1DailyLimitError } from './d1-usage';

it.each([
  'D1_ERROR: Exceeded daily rows written limit',
  'D1 exceeded its daily write limit',
  'Your account has exceeded D1’s free tier daily row read limit. Wait until midnight UTC.',
])('recognizes a D1 daily limit: %s', message => {
  expect(isD1DailyLimitError(new Error(message))).toBe(true);
});

it.each([
  'The daily notification request budget is exhausted. Try again tomorrow.',
  'Request body exceeded configured limit',
  'D1_ERROR: Exceeded maximum DB size',
])('leaves other failures alone: %s', message => {
  expect(isD1DailyLimitError(new Error(message))).toBe(false);
});
