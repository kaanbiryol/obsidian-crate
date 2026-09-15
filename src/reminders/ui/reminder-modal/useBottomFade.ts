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
        const ownerWindow = el.ownerDocument.defaultView;
        if (!ownerWindow) return;
        let frame = 0;

        const update = () => {
            const overflows = el.scrollHeight > el.clientHeight + 1;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
            setShow(overflows && !atBottom);
        };
        const scheduleUpdate = () => {
            // WebKit can flush a native listener's React update before the
            // delegated onChange handler runs, restoring the old textarea value.
            // Measure after the input dispatch and coalesce scroll/resize events.
            if (frame) return;
            frame = ownerWindow.requestAnimationFrame(() => {
                frame = 0;
                update();
            });
        };

        update();
        el.addEventListener('scroll', scheduleUpdate, { passive: true });
        el.addEventListener('input', scheduleUpdate);
        const resizeObserver = new ResizeObserver(scheduleUpdate);
        resizeObserver.observe(el);

        return () => {
            el.removeEventListener('scroll', scheduleUpdate);
            el.removeEventListener('input', scheduleUpdate);
            resizeObserver.disconnect();
            if (frame) ownerWindow.cancelAnimationFrame(frame);
        };
    }, [ref]);

    return show;
}
