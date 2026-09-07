import { useEffect, useRef, useState } from 'react';

interface KeyboardViewportMetrics {
  layoutHeight: number;
  visualHeight: number;
  visualOffsetTop: number;
}

export function calculateKeyboardInset({
  layoutHeight,
  visualHeight,
  visualOffsetTop,
}: KeyboardViewportMetrics): number {
  return Math.max(0, Math.round(layoutHeight - visualHeight - visualOffsetTop));
}

function isEditableElement(target: EventTarget | null): target is HTMLElement {
  return target instanceof HTMLElement && (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable ||
    target.getAttribute('contenteditable') === 'true'
  );
}

function getEditableEventTarget(event: FocusEvent): HTMLElement | null {
  return event.composedPath().find(isEditableElement) ?? null;
}

function getDeepActiveElement(): Element | null {
  let activeElement: Element | null = document.activeElement;
  while (activeElement?.shadowRoot?.activeElement) {
    activeElement = activeElement.shadowRoot.activeElement;
  }
  return activeElement;
}

function getLayoutHeight(): number {
  return Math.max(
    window.innerHeight,
    document.documentElement.clientHeight,
    (window.visualViewport?.height ?? 0) + (window.visualViewport?.offsetTop ?? 0),
  );
}

/**
 * Hook to track keyboard visibility on mobile devices.
 *
 * On iOS, the layout viewport remains full-height while visualViewport describes
 * the visible area above the software keyboard. Focus gates the measurement so
 * browser chrome changes are not mistaken for a keyboard.
 */
export function useKeyboardHeight(enabled: boolean = true): number {
  const [keyboardInset, setKeyboardInset] = useState(0);
  const keyboardInsetRef = useRef(0);
  const hasEditableFocusRef = useRef(false);
  const layoutHeightRef = useRef(0);
  const layoutWidthRef = useRef(0);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      keyboardInsetRef.current = 0;
      setKeyboardInset(0);
      return;
    }

    const updateLayoutBaseline = () => {
      const width = window.innerWidth;
      if (layoutWidthRef.current !== width) {
        layoutWidthRef.current = width;
        layoutHeightRef.current = getLayoutHeight();
        return;
      }
      layoutHeightRef.current = Math.max(layoutHeightRef.current, getLayoutHeight());
    };

    const measure = () => {
      // Blur starts the native keyboard animation. Keep following the viewport
      // until the measured keyboard closes instead of dropping the sheet early.
      if ((!hasEditableFocusRef.current && keyboardInsetRef.current === 0) || !window.visualViewport) {
        updateLayoutBaseline();
        keyboardInsetRef.current = 0;
        setKeyboardInset(0);
        return;
      }

      const inset = calculateKeyboardInset({
        layoutHeight: Math.max(layoutHeightRef.current, getLayoutHeight()),
        visualHeight: window.visualViewport.height,
        visualOffsetTop: window.visualViewport.offsetTop,
      });
      keyboardInsetRef.current = inset;
      setKeyboardInset(inset);
    };

    let animationFrame: number | null = null;
    const scheduleMeasure = () => {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        measure();
      });
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (!getEditableEventTarget(event)) return;
      hasEditableFocusRef.current = true;
      measure();
    };

    const handleFocusOut = (event: FocusEvent) => {
      if (isEditableElement(event.relatedTarget)) return;
      hasEditableFocusRef.current = false;
      scheduleMeasure();
    };

    updateLayoutBaseline();
    hasEditableFocusRef.current = isEditableElement(getDeepActiveElement());
    measure();

    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
    window.addEventListener('resize', scheduleMeasure);
    window.visualViewport?.addEventListener('resize', scheduleMeasure);
    window.visualViewport?.addEventListener('scroll', scheduleMeasure);

    return () => {
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
      window.removeEventListener('resize', scheduleMeasure);
      window.visualViewport?.removeEventListener('resize', scheduleMeasure);
      window.visualViewport?.removeEventListener('scroll', scheduleMeasure);
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    };
  }, [enabled]);

  return enabled ? keyboardInset : 0;
}
