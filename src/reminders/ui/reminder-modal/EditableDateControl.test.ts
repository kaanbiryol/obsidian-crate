import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { EditableDateControl, formatDisplayDate } from './EditableDateControl';

describe('editable date control', () => {
	it('formats the resting date for the locale', () => {
		expect(formatDisplayDate('2026-09-03', 'en-US')).toBe('Sep 3, 2026');
		expect(formatDisplayDate('')).toBe('');
	});

	it('uses one accessible native date input with four-digit year limits', () => {
		const markup = renderToStaticMarkup(React.createElement(EditableDateControl, {
			label: 'Date', emptyLabel: 'Add date', invalidMessage: 'Enter a valid date',
			value: '2026-09-03', onChange: vi.fn(),
		}));
		expect(markup.match(/<input/g)).toHaveLength(1);
		expect(markup).toContain('type="date"');
		expect(markup).toContain('aria-label="Date"');
		expect(markup).toContain('min="0001-01-01"');
		expect(markup).toContain('max="9999-12-31"');
		expect(markup).not.toContain('type="text"');
		expect(markup).not.toContain('tabindex="-1"');
	});
});
