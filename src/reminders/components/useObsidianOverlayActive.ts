import { useLayoutEffect, useState } from 'react';

function nativeModal(element: HTMLElement): Element | null {
    let current: Element | null = element;
    while (current) {
        const modal = current.closest('.modal-container');
        if (modal) return modal;
        const root = current.getRootNode();
        current = 'host' in root ? (root as ShadowRoot).host : null;
    }
    return null;
}

/** Read live DOM state before deferred work can move focus behind a native overlay. */
export function isObsidianOverlayActive(container: HTMLElement): boolean {
    const host = nativeModal(container);
    if (!host) return true;
    const document = container.ownerDocument;
    const modals = document.querySelectorAll('.modal-container');
    return modals[modals.length - 1] === host && !document.querySelector('.menu, .suggestion-container');
}

/** Yield the focus trap to native Obsidian menus and dialogs opened above this sheet. */
export function useObsidianOverlayActive(container: HTMLElement | null): boolean {
    const [active, setActive] = useState(true);
    useLayoutEffect(() => {
        if (!container) return;
        const host = nativeModal(container);
        if (!host) return;
        const document = container.ownerDocument;
        const update = () => {
            setActive(isObsidianOverlayActive(container));
        };
        const observer = new MutationObserver(update);
        observer.observe(document.body, { childList: true });
        update();
        return () => observer.disconnect();
    }, [container]);
    return active;
}
