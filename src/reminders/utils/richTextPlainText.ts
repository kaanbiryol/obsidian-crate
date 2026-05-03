/**
 * Extract plain text from a contenteditable element
 */
export const getPlainText = (element: HTMLElement | null): string => {
    if (!element) return '';

    let text = '';
    const walk = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent || '';
        } else if (node.nodeName === 'BR') {
            text += '\n';
        } else if (node.nodeName === 'A' && (node as HTMLElement).hasAttribute('data-markdown-link')) {
            const linkText = node.textContent || '';
            const href = (node as HTMLAnchorElement).getAttribute('href') || '';
            text += `[${linkText}](${href})`;
        } else if (node.childNodes) {
            node.childNodes.forEach(walk);
        }
    };
    walk(element);
    return text;
};
