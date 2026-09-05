import { findAllMatches } from './richTextMatchers';

type RichTextSegment =
    | { kind: 'text'; text: string }
    | { kind: 'chip'; text: string; type: 'priority' | 'date' | 'project' }
    | { kind: 'link'; text: string; url: string };

export interface RichTextChipParts {
    marker: string;
    label: string;
}

export function getRichTextChipParts(type: string, text: string): RichTextChipParts {
    if (type === 'priority') {
        return { marker: text, label: '' };
    }

    if (type === 'project' && text.startsWith('#')) {
        return { marker: '#', label: text.slice(1) };
    }

    return { marker: '', label: text };
}

/**
 * Escape HTML special characters
 */
const escapeHTML = (str: string): string => {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/\n/g, '<br>');
};

/**
 * Create HTML for a chip
 */
export const createChipHTML = (type: string, text: string): string => {
    const chipType = ['priority', 'date', 'project'].includes(type) ? type : 'default';
    const { marker, label } = getRichTextChipParts(chipType, text);
    const markerHTML = marker
        ? `<span class="rich-text-chip-marker">${escapeHTML(marker)}</span>`
        : '';
    return `<span class="rich-text-chip rich-text-chip-${chipType}">${markerHTML}${escapeHTML(label)}</span>`;
};

export const buildRichTextSegments = (text: string, knownProjects?: string[]): RichTextSegment[] => {
    if (!text) return [];

    const segments: RichTextSegment[] = [];
    let lastIndex = 0;

    for (const match of findAllMatches(text, knownProjects)) {
        if (match.index > lastIndex) {
            segments.push({ kind: 'text', text: text.slice(lastIndex, match.index) });
        }

        if (match.type === 'link' && match.linkText !== undefined && match.linkUrl !== undefined) {
            segments.push({ kind: 'link', text: match.linkText, url: match.linkUrl });
        } else if (match.type !== 'link') {
            segments.push({ kind: 'chip', text: match.text, type: match.type });
        }

        lastIndex = match.index + match.length;
    }

    if (lastIndex < text.length) {
        segments.push({ kind: 'text', text: text.slice(lastIndex) });
    }

    return segments;
};

/**
 * Build HTML with chips from plain text
 * @param text The text to render
 * @param knownProjects Optional array of known project names for multi-word matching
 */
export const buildHTML = (text: string, knownProjects?: string[]): string => {
    return buildRichTextSegments(text, knownProjects).map((segment) => {
        if (segment.kind === 'text') return escapeHTML(segment.text);
        if (segment.kind === 'chip') return createChipHTML(segment.type, segment.text);
        return `<a href="${escapeHTML(segment.url)}" class="reminder-markdown-link" data-markdown-link="true" target="_blank" rel="noopener noreferrer">${escapeHTML(segment.text)}</a>`;
    }).join('');
};
