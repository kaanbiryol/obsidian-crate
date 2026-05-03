import { getFontWeight } from '../ui/themes';
import { findAllMatches } from './richTextMatchers';

/**
 * Escape HTML special characters
 */
export const escapeHTML = (str: string): string => {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/\n/g, '<br>');
};

/**
 * Get chip styles for different types
 * Minimal, inline annotation style - subtle enough to not overpower text
 */
export const getChipStyle = (type: string, _text: string): string => {
    const fontWeight = getFontWeight('medium');
    const baseStyle = `
        padding: 1px 6px;
        border-radius: 6px;
        display: inline;
        font-size: inherit;
        font-weight: ${fontWeight};
        letter-spacing: 0.01em;
        margin: 0 1px;
        box-decoration-break: clone;
        -webkit-box-decoration-break: clone;
        vertical-align: baseline;
    `.replace(/\s+/g, ' ').trim();

    // Refined, understated chips - color only, very subtle background
    if (type === 'priority') {
        return baseStyle + `
            background: hsl(var(--heroui-danger) / 0.08);
            color: hsl(var(--heroui-danger));
        `.replace(/\s+/g, ' ').trim();
    } else if (type === 'date') {
        return baseStyle + `
            background: hsl(var(--heroui-success) / 0.08);
            color: hsl(var(--heroui-success));
        `.replace(/\s+/g, ' ').trim();
    } else if (type === 'project') {
        return baseStyle + `
            background: hsl(var(--heroui-primary) / 0.08);
            color: hsl(var(--heroui-primary));
        `.replace(/\s+/g, ' ').trim();
    }
    return baseStyle;
};

/**
 * Create HTML for a chip
 */
export const createChipHTML = (type: string, text: string): string => {
    const escapedText = escapeHTML(text);
    const style = getChipStyle(type, text);
    return `<span class="rich-text-chip" style="${style}">${escapedText}</span>`;
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
