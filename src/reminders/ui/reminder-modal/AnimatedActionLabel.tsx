import React, { useLayoutEffect, useRef } from 'react';

/** Animate the measured width so adjacent chips move without stretching text. */
export function AnimatedActionLabel({ children }: { children: string }) {
    const containerRef = useRef<HTMLSpanElement>(null);
    const textRef = useRef<HTMLSpanElement>(null);
    const initializedRef = useRef(false);
    const widthAnimationRef = useRef<Animation | null>(null);
    const textAnimationRef = useRef<Animation | null>(null);

    useLayoutEffect(() => {
        const container = containerRef.current;
        const text = textRef.current;
        if (!container || !text) return;

        const updateWidth = () => {
            const previousWidth = container.getBoundingClientRect().width;
            const nextWidth = text.getBoundingClientRect().width;
            widthAnimationRef.current?.cancel();
            textAnimationRef.current?.cancel();
            container.style.width = `${nextWidth}px`;

            if (initializedRef.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                widthAnimationRef.current = container.animate(
                    [{ width: `${previousWidth}px` }, { width: `${nextWidth}px` }],
                    { duration: 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
                );
                textAnimationRef.current = text.animate(
                    [{ opacity: 0.55, transform: 'translateY(2px)' }, { opacity: 1, transform: 'translateY(0)' }],
                    { duration: 180, easing: 'ease-out' },
                );
            }
            initializedRef.current = true;
        };

        updateWidth();
    }, [children]);

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
