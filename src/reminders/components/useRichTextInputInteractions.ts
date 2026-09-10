import { useCallback } from 'react';
import type React from 'react';
import { insertPlainTextAtSelection } from './richTextInputDom';
import { getRichTextHistoryAction } from './richTextInputHistory';

interface UseRichTextInputInteractionsOptions {
	onKeyDown?: (e: React.KeyboardEvent) => void;
	onAutocompleteKeyDown?: (e: React.KeyboardEvent) => boolean;
	onUndo?: () => boolean;
	onRedo?: () => boolean;
	captureHistorySnapshot?: () => void;
	handleInput: (paste?: boolean) => void;
}

export function useRichTextInputInteractions({
	onKeyDown,
	onAutocompleteKeyDown,
	onUndo,
	onRedo,
	captureHistorySnapshot,
	handleInput,
}: UseRichTextInputInteractionsOptions) {
	const handleClick = useCallback((e: React.MouseEvent) => {
		if (!e.metaKey && !e.ctrlKey) return;
		const target = e.target as HTMLElement;
		const linkEl = target.closest('a[data-markdown-link]');
		if (linkEl instanceof HTMLAnchorElement) {
			e.preventDefault();
			const url = linkEl.getAttribute('href');
			if (url) {
				window.open(url, '_blank', 'noopener,noreferrer');
			}
		}
	}, []);

	const handleKeyDownInternal = useCallback((e: React.KeyboardEvent) => {
		const historyAction = getRichTextHistoryAction(e);
		if (historyAction) {
			const handled = historyAction === 'undo' ? onUndo?.() : onRedo?.();
			if (handled) {
				e.preventDefault();
				return;
			}
		}

		if (onAutocompleteKeyDown?.(e)) return;
		onKeyDown?.(e);
	}, [onAutocompleteKeyDown, onKeyDown, onRedo, onUndo]);

	const handlePaste = useCallback((e: React.ClipboardEvent) => {
		e.preventDefault();
		captureHistorySnapshot?.();
		const text = e.clipboardData.getData('text/plain');
		insertPlainTextAtSelection(text);
		handleInput(true);
	}, [captureHistorySnapshot, handleInput]);

	return {
		handleClick,
		handleKeyDownInternal,
		handlePaste,
	};
}
