import { describe, expect, it } from 'vitest';

import {
	formatEditableDate,
	formatDisplayDate,
	getEditableDatePlaceholder,
	parseEditableDate,
} from './EditableDateControl';

describe('editable date control', () => {
	it('formats and parses dates in locale order', () => {
		expect(formatEditableDate('2026-09-03', 'de-DE')).toBe('03.09.2026');
		expect(formatDisplayDate('2026-09-03', 'en-US')).toBe('Sep 3, 2026');
		expect(parseEditableDate('03.09.2026', 'de-DE')).toBe('2026-09-03');
		expect(getEditableDatePlaceholder('de-DE')).toBe('DD.MM.YYYY');
	});

	it('accepts ISO input and rejects invalid calendar dates', () => {
		expect(parseEditableDate('2026-09-03', 'de-DE')).toBe('2026-09-03');
		expect(parseEditableDate('31.02.2026', 'de-DE')).toBeNull();
	});
});
