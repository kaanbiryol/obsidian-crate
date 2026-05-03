import { useEffect, useState } from 'react';
import type React from 'react';

/**
 * Track whether a scrollable element has content below the visible area.
 * Returns true when the element overflows and isn't scrolled to the bottom.
 */
export function useBottomFade(ref: React.RefObject<HTMLElement | null>): boolean {
    const [show, setShow] = useState(false);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;

        const update = () => {
            const overflows = el.scrollHeight > el.clientHeight + 1;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
            setShow(overflows && !atBottom);
        };

        update();
        el.addEventListener('scroll', update, { passive: true });
        el.addEventListener('input', update);
        const resizeObserver = new ResizeObserver(update);
        resizeObserver.observe(el);

        return () => {
            el.removeEventListener('scroll', update);
            el.removeEventListener('input', update);
            resizeObserver.disconnect();
        };
    }, [ref]);

    return show;
}
