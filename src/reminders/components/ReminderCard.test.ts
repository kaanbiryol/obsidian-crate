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
        expect(markup).toContain('premium-checkbox-icon');
        expect(markup).not.toContain('premium-reminder-card is-completed');
        expect(markup).not.toContain('premium-reminder-title is-completed');
    });
});
