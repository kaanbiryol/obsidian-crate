import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RichTextInput } from './RichTextInput';

describe('RichTextInput', () => {
    it('exposes autocomplete state to assistive technology', () => {
        const markup = renderToStaticMarkup(React.createElement(RichTextInput, {
            value: '#pro',
            onChange: vi.fn(),
            ariaLabel: 'Reminder title',
            ariaControls: 'project-autocomplete-listbox',
            ariaActiveDescendant: 'project-autocomplete-option-1',
            ariaExpanded: true,
        }));

        expect(markup).toContain('aria-autocomplete="list"');
        expect(markup).toContain('aria-controls="project-autocomplete-listbox"');
        expect(markup).toContain('aria-activedescendant="project-autocomplete-option-1"');
        expect(markup).toContain('aria-expanded="true"');
    });
});
