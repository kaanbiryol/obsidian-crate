import { findAllMatches } from './richTextMatchers';

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
    const escapedText = escapeHTML(text);
    const chipType = ['priority', 'date', 'project'].includes(type) ? type : 'default';
    return `<span class="rich-text-chip rich-text-chip-${chipType}">${escapedText}</span>`;
};

/**
 * Build HTML with chips from plain text
 * @param text The text to render
 * @param knownProjects Optional array of known project names for multi-word matching
 */
export const buildHTML = (text: string, knownProjects?: string[]): string => {
    if (!text) return '';

    const parts: string[] = [];
    let lastIndex = 0;
    const matches = findAllMatches(text, knownProjects);

    // Build HTML parts
    matches.forEach((match) => {
        // Add text before match
        if (match.index > lastIndex) {
            const beforeText = text.slice(lastIndex, match.index);
            parts.push(escapeHTML(beforeText));
        }

        if (match.type === 'link' && match.linkText !== undefined && match.linkUrl !== undefined) {
            parts.push(
                `<a href="${escapeHTML(match.linkUrl)}" class="reminder-markdown-link" data-markdown-link="true" target="_blank" rel="noopener noreferrer">${escapeHTML(match.linkText)}</a>`
            );
        } else {
            parts.push(createChipHTML(match.type, match.text));
        }

        lastIndex = match.index + match.length;
    });

    // Add remaining text
    if (lastIndex < text.length) {
        parts.push(escapeHTML(text.slice(lastIndex)));
    }

    return parts.join('');
};
