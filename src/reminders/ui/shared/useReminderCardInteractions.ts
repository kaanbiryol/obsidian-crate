import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useIsPresent } from 'motion/react';

interface ReminderCardInteractionsOptions {
	completed: boolean;
	onEdit: () => void;
	onToggleComplete: () => void | Promise<void>;
}

interface ReminderCardInteractions {
	wrapperRef: RefObject<HTMLDivElement | null>;
	/** Checks the box while a completion settles; the card ignores input meanwhile. */
	completionPreview: boolean;
}

const CHECKBOX_SELECTOR = [
	'.premium-checkbox',
	'[role="checkbox"]',
	'[data-slot="wrapper"]',
	'input[type="checkbox"]',
].join(', ');

/**
 * Connects a reminder card to native capture-phase interactions and runs one
 * completion toggle at a time.
 *
 * Native listeners are intentional: the plugin renders inside a Shadow DOM,
 * where third-party component handlers can stop synthetic events before they
 * reach the card wrapper.
 */
export function useReminderCardInteractions({
	completed,
	onEdit,
	onToggleComplete,
}: ReminderCardInteractionsOptions): ReminderCardInteractions {
	const wrapperRef = useRef<HTMLDivElement>(null);
	const mountedRef = useRef(true);
	const isCompletingRef = useRef(false);
	const [completionPreview, setCompletionPreview] = useState(false);
	// An exiting row keeps its last props, so it keeps the checked preview too.
	const isPresent = useIsPresent();
	const isPresentRef = useRef(isPresent);
	isPresentRef.current = isPresent;

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	useEffect(() => {
		if (completed) setCompletionPreview(false);
	}, [completed]);

	const toggleComplete = useCallback(() => {
		if (isCompletingRef.current) return;
		isCompletingRef.current = true;
		if (!completed) setCompletionPreview(true);
		void Promise.resolve()
			.then(onToggleComplete)
			.finally(() => {
				isCompletingRef.current = false;
				if (mountedRef.current && isPresentRef.current) setCompletionPreview(false);
			});
	}, [completed, onToggleComplete]);

	const optionsRef = useRef({ onEdit, onToggleComplete: toggleComplete, isDisabled: () => isCompletingRef.current });
	optionsRef.current = { onEdit, onToggleComplete: toggleComplete, isDisabled: () => isCompletingRef.current };

	useEffect(() => {
		const wrapper = wrapperRef.current;
		if (!wrapper) return;

		const handleClick = (event: MouseEvent) => {
			const target = event.target as Element;
			const options = optionsRef.current;

			if (options.isDisabled()) {
				event.stopPropagation();
				return;
			}

			if (target.closest(CHECKBOX_SELECTOR)) {
				event.stopPropagation();
				options.onToggleComplete();
				return;
			}

			if (target.closest('a[data-markdown-link]')) {
				event.stopPropagation();
				return;
			}

			options.onEdit();
		};

		const handleKeyDown = (event: KeyboardEvent) => {
			if (optionsRef.current.isDisabled()) return;
			if (event.target !== wrapper || (event.key !== 'Enter' && event.key !== ' ')) return;
			event.preventDefault();
			optionsRef.current.onEdit();
		};

		wrapper.addEventListener('click', handleClick, true);
		wrapper.addEventListener('keydown', handleKeyDown);
		return () => {
			wrapper.removeEventListener('click', handleClick, true);
			wrapper.removeEventListener('keydown', handleKeyDown);
		};
	}, []);

	return { wrapperRef, completionPreview };
}
