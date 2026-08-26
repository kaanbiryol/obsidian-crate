import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RichTextInput } from './RichTextInput';

describe('RichTextInput', () => {
    it('keeps synchronous initial content opt-in for PWA callers', () => {
        const markup = renderToStaticMarkup(React.createElement(RichTextInput, {
            value: 'Plugin reminder',
            onChange: vi.fn(),
            ariaLabel: 'Reminder title',
        }));

        expect(markup).not.toContain('Plugin reminder');
    });

    it('includes the initial value in the first PWA-rendered frame', () => {
        const markup = renderToStaticMarkup(React.createElement(RichTextInput, {
            value: 'Check this article',
            onChange: vi.fn(),
            ariaLabel: 'Reminder title',
            syncContentBeforePaint: true,
        }));

        expect(markup).toContain('Check this article');
    });

    it('renders a stable non-editable title layer while the PWA sheet opens', () => {
        const markup = renderToStaticMarkup(React.createElement(RichTextInput, {
            value: 'Check this article',
            onChange: vi.fn(),
            ariaLabel: 'Reminder title',
            syncContentBeforePaint: true,
            stabilizeInitialPaint: true,
        }));

        expect(markup).toContain('has-paint-stabilizer');
        expect(markup).toContain('rich-text-input-paint-stabilizer');
        expect(markup.match(/Check this article/g)).toHaveLength(2);
    });
});
