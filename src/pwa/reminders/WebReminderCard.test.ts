import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { getProjectColor } from '@/reminders/ui/format/projectColors';
import { WebReminderCard } from './WebReminderCard';

const reminder = { id: 'reminder-1', content: 'Pick up flowers', completed: false, priority: 4 as const, project: 'Home' };

function render(colorScheme: 'light' | 'dark') {
	return renderToStaticMarkup(React.createElement(WebReminderCard, {
		reminder,
		colorScheme,
		index: 0,
		hideProject: false,
		onEdit: () => {},
		onToggleComplete: () => {},
	}));
}

describe('WebReminderCard', () => {
	it('uses the project color for the active theme', () => {
		const { light, dark } = getProjectColor('Home');
		expect(render('light')).toContain(light.accent);
		expect(render('light')).not.toContain(dark.accent);
		expect(render('dark')).toContain(dark.accent);
	});
});
