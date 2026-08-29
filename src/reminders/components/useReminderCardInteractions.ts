import { useEffect, useRef, type RefObject } from 'react';

interface ReminderCardInteractionsOptions {
  onEdit: () => void;
  onToggleComplete: () => void | Promise<void>;
  isDisabled?: () => boolean;
}

const CHECKBOX_SELECTOR = [
  '.premium-checkbox',
  '[role="checkbox"]',
  '[data-slot="wrapper"]',
  'input[type="checkbox"]',
].join(', ');

/**
 * Connects a reminder card to native capture-phase interactions.
 *
 * Native listeners are intentional: the plugin renders inside a Shadow DOM,
 * where third-party component handlers can stop synthetic events before they
 * reach the card wrapper.
 */
export function useReminderCardInteractions({
  onEdit,
  onToggleComplete,
  isDisabled = () => false,
}: ReminderCardInteractionsOptions): RefObject<HTMLDivElement | null> {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef({ onEdit, onToggleComplete, isDisabled });
  optionsRef.current = { onEdit, onToggleComplete, isDisabled };

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

      if (target.closest('.reorder-drag-handle')) {
        event.stopPropagation();
        return;
      }

      if (target.closest(CHECKBOX_SELECTOR)) {
        event.stopPropagation();
        void options.onToggleComplete();
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

  return wrapperRef;
}
