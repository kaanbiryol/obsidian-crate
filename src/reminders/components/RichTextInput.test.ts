import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RichTextInput } from './RichTextInput';
import { buildHTML } from '../utils/richTextRenderer';

describe('RichTextInput', () => {
    it('keeps priority as editable text with matching initial and update markup', () => {
        const markup = renderToStaticMarkup(React.createElement(RichTextInput, {
            value: 'Review !',
            onChange: vi.fn(),
            syncContentBeforePaint: true,
        }));

        expect(markup).toContain(buildHTML('Review !'));
        expect(markup).toContain('<span class="rich-text-chip-marker">!</span>');
        expect(markup).not.toContain('contenteditable="false"');
    });

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

    it('renders initial content before handling autofocus', () => {
        const markup = renderToStaticMarkup(React.createElement(RichTextInput, {
            value: 'Edit this reminder',
            onChange: vi.fn(),
            ariaLabel: 'Reminder title',
            autoFocus: true,
        }));

        expect(markup).toContain('Edit this reminder');
        expect(markup).not.toContain('autofocus');
    });

    it('renders the editable project marker separately from its label', () => {
        const markup = renderToStaticMarkup(React.createElement(RichTextInput, {
            value: 'Review #Crate Demo',
            onChange: vi.fn(),
            ariaLabel: 'Reminder title',
            knownProjects: ['Crate Demo'],
            syncContentBeforePaint: true,
        }));

        expect(markup).toContain('<span class="rich-text-chip-marker">#</span>Crate Demo');
    });

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
