import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReminderCard } from './ReminderCard';

const reminder = {
    id: 'reminder-1',
    content: 'Finish the report',
    completed: false,
};

describe('ReminderCard', () => {
    it('previews a checked circle without marking the card content completed', () => {
        const markup = renderToStaticMarkup(React.createElement(ReminderCard, {
            reminder,
            animationConfig: { enabled: false },
            completionPreview: true,
        }));

        expect(markup).toContain('premium-checkbox is-checked is-completing');
        expect(markup).toContain('aria-checked="true"');
        expect(markup).toContain('aria-disabled="true"');
        expect(markup).toContain('premium-checkbox-visual');
        expect(markup).toContain('premium-checkbox-icon');
        expect(markup).not.toContain('premium-reminder-card is-completed');
        expect(markup).not.toContain('premium-reminder-title is-completed');
    });

    it('renders important status as a labeled title-row indicator', () => {
        const markup = renderToStaticMarkup(React.createElement(ReminderCard, {
            reminder: { ...reminder, priority: 1 },
            animationConfig: { enabled: false },
        }));

        expect(markup).toContain('class="premium-priority-flag"');
        expect(markup).toContain('aria-label="High priority"');
        expect(markup).toMatch(/premium-reminder-title-row[\s\S]*premium-priority-flag/);
    });
});
