import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { IconButton } from './IconButton';
import { ProgressMeter } from './ProgressMeter';
import { PickerFieldRow } from '../ui/reminder-modal/PickerFieldRow';
import { PickerSection } from '../ui/reminder-modal/PickerSection';
import { CompletedReminderSection } from '../ui/views/CompletedReminderSection';

describe('shared UI primitives', () => {
	it('applies one accessible contract to icon-only actions', () => {
		const markup = renderToStaticMarkup(React.createElement(IconButton, {
			icon: 'trash-2',
			label: 'Delete reminder',
			onClick: vi.fn(),
			tone: 'danger',
			size: 'small',
		}));

		expect(markup).toContain('class="crate-icon-button"');
		expect(markup).toContain('aria-label="Delete reminder"');
		expect(markup).toContain('data-size="small"');
		expect(markup).toContain('data-tone="danger"');
		expect(markup).toContain('data-icon="trash-2"');
	});

	it('shares picker section and field-row hierarchy', () => {
		const field = React.createElement(PickerFieldRow, {
			label: 'Time',
			detail: 'Optional',
			asLabel: true,
			children: React.createElement('input', { type: 'time', 'aria-label': 'Time' }),
		});
		const markup = renderToStaticMarkup(React.createElement(PickerSection, {
			headingId: 'custom-heading',
			title: 'Custom',
			children: field,
		}));

		expect(markup).toContain('class="picker-section"');
		expect(markup).toContain('aria-labelledby="custom-heading"');
		expect(markup).toContain('<h4 id="custom-heading">Custom</h4>');
		expect(markup).toContain('class="picker-control-row"');
		expect(markup).toContain('<small>Optional</small>');
	});

	it('clamps project progress and labels it for assistive technology', () => {
		const markup = renderToStaticMarkup(React.createElement(ProgressMeter, {
			percentage: 125,
			label: 'Work completion',
		}));

		expect(markup).toContain('class="crate-progress-meter"');
		expect(markup).toContain('aria-label="Work completion"');
		expect(markup).toContain('aria-valuenow="100"');
		expect(markup).toContain('width:100%');
	});

	it('renders the shared completed-reminder toggle consistently', () => {
		const markup = renderToStaticMarkup(React.createElement(CompletedReminderSection, {
			reminders: [{
				id: 'done-1',
				content: 'Finished task',
				priority: 4,
				completed: true,
			}],
			showCompleted: false,
			onToggle: vi.fn(),
			renderCard: (reminder) => React.createElement('span', null, reminder.content),
			animationConfig: { enabled: false },
		}));

		expect(markup).toContain('Completed (1)');
		expect(markup).toContain('class="completed-section-toggle');
		expect(markup).toContain('aria-expanded="false"');
		expect(markup).not.toContain('Finished task');
	});
});
