import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RichTextInput } from './RichTextInput';

describe('RichTextInput', () => {
    it('includes the initial value in the first rendered frame', () => {
        const markup = renderToStaticMarkup(React.createElement(RichTextInput, {
            value: 'Check this article',
            onChange: vi.fn(),
            ariaLabel: 'Reminder title',
        }));

        expect(markup).toContain('Check this article');
    });
});
