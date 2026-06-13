import { useCallback } from 'react';
import type React from 'react';
import { insertPlainTextAtSelection } from './richTextInputDom';

interface UseRichTextInputInteractionsOptions {
	onKeyDown?: (e: React.KeyboardEvent) => void;
	onAutocompleteKeyDown?: (e: React.KeyboardEvent) => boolean;
	handleInput: () => void;
}

export function useRichTextInputInteractions({
	onKeyDown,
	onAutocompleteKeyDown,
	handleInput,
}: UseRichTextInputInteractionsOptions) {
	const handleClick = useCallback((e: React.MouseEvent) => {
		const target = e.target as HTMLElement;
		const linkEl = target.closest('a[data-markdown-link]');
		if (linkEl instanceof HTMLAnchorElement) {
			e.preventDefault();
			if (e.metaKey || e.ctrlKey) {
				const url = linkEl.getAttribute('href');
				if (url) {
					window.open(url, '_blank', 'noopener,noreferrer');
				}
			}
		}
	}, []);

	const handleKeyDownInternal = useCallback((e: React.KeyboardEvent) => {
		if (onAutocompleteKeyDown?.(e)) return;
		onKeyDown?.(e);
	}, [onAutocompleteKeyDown, onKeyDown]);

	const handlePaste = useCallback((e: React.ClipboardEvent) => {
		e.preventDefault();
		const text = e.clipboardData.getData('text/plain');
		insertPlainTextAtSelection(text);
		handleInput();
	}, [handleInput]);

	const handleMouseDown = useCallback((e: React.MouseEvent) => {
		const target = e.target as HTMLElement;
		if (target.closest('button, [role="button"], .pill, [data-slot="base"]')) {
			e.preventDefault();
		}
	}, []);

	const handleTouchStart = useCallback((e: React.TouchEvent) => {
		const target = e.target as HTMLElement;
		if (target.closest('button, [role="button"], .pill, [data-slot="base"]')) {
			// Don't prevent default here as it would break button interaction.
		}
	}, []);

	return {
		handleClick,
		handleKeyDownInternal,
		handlePaste,
		handleMouseDown,
		handleTouchStart,
	};
}
