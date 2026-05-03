import { useEffect } from 'react';
import type React from 'react';

const MAX_DESCRIPTION_HEIGHT = 120;

export function autosizeTextarea(element: HTMLTextAreaElement): void {
    element.setCssProps({ height: 'auto' });
    element.setCssProps({ height: `${Math.min(element.scrollHeight, MAX_DESCRIPTION_HEIGHT)}px` });
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
