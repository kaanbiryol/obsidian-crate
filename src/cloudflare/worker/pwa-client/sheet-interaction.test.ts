import { describe, expect, it } from 'vitest';
import { shouldPreserveSheetFocus } from './sheet-interaction';

describe('bottom-sheet focus preservation', () => {
	it('preserves focus for non-interactive sheet contacts', () => {
		expect(shouldPreserveSheetFocus({ isInteractiveTarget: false })).toBe(true);
	});

	it('allows interactive controls', () => {
		expect(shouldPreserveSheetFocus({ isInteractiveTarget: true })).toBe(false);
	});
});
