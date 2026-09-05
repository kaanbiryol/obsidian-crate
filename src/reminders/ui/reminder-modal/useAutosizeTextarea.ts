import { useEffect } from 'react';
import type React from 'react';

const MAX_DESCRIPTION_HEIGHT = 120;

export function autosizeTextarea(element: HTMLTextAreaElement): void {
    // Shared with the PWA, where Obsidian's setCssProps extension is unavailable.
    element.style.setProperty('height', 'auto');
    element.style.setProperty('height', `${Math.min(element.scrollHeight, MAX_DESCRIPTION_HEIGHT)}px`);
}

export function useAutosizeTextarea(
    ref: React.RefObject<HTMLTextAreaElement | null>,
    enabled: boolean,
): void {
    useEffect(() => {
        const element = ref.current;
        if (element && enabled) {
            autosizeTextarea(element);
        }
    }, [enabled, ref]);
}
