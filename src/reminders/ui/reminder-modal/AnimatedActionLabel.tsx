import React, { useLayoutEffect, useRef } from 'react';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';

/** Resize around live metadata without scaling text or delaying parsed values. */
export function AnimatedActionLabel({ children }: { children: string }) {
    const containerRef = useRef<HTMLSpanElement>(null);
    const textRef = useRef<HTMLSpanElement>(null);
    const previousLabelRef = useRef(children);
    const widthAnimationRef = useRef<Animation | null>(null);
    const textAnimationRef = useRef<Animation | null>(null);
    const previousWidthRef = useRef<number | null>(null);
    const reducedMotion = useObsidianReducedMotion();

    useLayoutEffect(() => {
        const container = containerRef.current;
        const text = textRef.current;
        if (!container || !text) return;

        const changed = previousLabelRef.current !== children;
        previousLabelRef.current = children;
        const resizing = widthAnimationRef.current?.playState === 'running';
        const previousWidth = resizing
            ? container.getBoundingClientRect().width
            : previousWidthRef.current;
        // Continue an interrupted fade instead of flashing dim again on each keystroke.
        const opacity = textAnimationRef.current?.playState === 'running'
            ? container.ownerDocument.defaultView?.getComputedStyle(text).opacity ?? '1'
            : '0.8';
        widthAnimationRef.current?.cancel();
        textAnimationRef.current?.cancel();
        const nextWidth = container.getBoundingClientRect().width;
        previousWidthRef.current = nextWidth;

        if (!changed || reducedMotion || previousWidth === null) return;
        if (Math.abs(previousWidth - nextWidth) > 0.5) {
            widthAnimationRef.current = container.animate(
                [{ width: `${previousWidth}px` }, { width: `${nextWidth}px` }],
                { duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
            );
        }
        textAnimationRef.current = text.animate(
            [{ opacity }, { opacity: 1 }],
            { duration: 160, easing: 'ease-out' },
        );
    }, [children, reducedMotion]);

    useLayoutEffect(() => () => {
        widthAnimationRef.current?.cancel();
        textAnimationRef.current?.cancel();
    }, []);

    return (
        <span ref={containerRef} className="reminder-action-label is-animated">
            <span ref={textRef}>{children}</span>
        </span>
    );
}
