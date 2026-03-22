import { useState, useEffect } from 'react';

// Fixed iOS keyboard height that works well for most devices
const IOS_KEYBOARD_HEIGHT = 300;

/**
 * Hook to track keyboard visibility on mobile devices.
 *
 * On iOS in Obsidian, the keyboard overlays content without resizing the viewport,
 * so we detect keyboard by tracking focus on input elements and return a fixed offset.
 */
export function useKeyboardHeight(enabled: boolean = true): number {
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      return;
    }

    // Track focus/blur on any input element to detect keyboard
    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      // Check if focused element is an input, textarea, or contenteditable
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable ||
        target.getAttribute('contenteditable') === 'true'
      ) {
        setIsKeyboardVisible(true);
      }
    };

    const handleFocusOut = () => {
      // Small delay to check if focus moved to another input
      setTimeout(() => {
        const activeElement = document.activeElement as HTMLElement;
        if (
          !activeElement ||
          (activeElement.tagName !== 'INPUT' &&
            activeElement.tagName !== 'TEXTAREA' &&
            !activeElement.isContentEditable &&
            activeElement.getAttribute('contenteditable') !== 'true')
        ) {
          setIsKeyboardVisible(false);
        }
      }, 100);
    };

    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);

    // Check initial state
    const activeElement = document.activeElement as HTMLElement;
    if (
      activeElement &&
      (activeElement.tagName === 'INPUT' ||
        activeElement.tagName === 'TEXTAREA' ||
        activeElement.isContentEditable ||
        activeElement.getAttribute('contenteditable') === 'true')
    ) {
      setIsKeyboardVisible(true);
    }

    return () => {
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
    };
  }, [enabled]);

  return isKeyboardVisible ? IOS_KEYBOARD_HEIGHT : 0;
}
