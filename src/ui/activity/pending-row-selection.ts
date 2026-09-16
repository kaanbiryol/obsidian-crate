export interface PendingRowSelectionState {
    highlightedKeys?: Set<string>;
    anchorKey?: string;
}

/** Highlighted rows are independent of the checkboxes that include files in sync. */
export function createPendingRowSelection(sidebar: HTMLElement, keys: string[], state: PendingRowSelectionState) {
    const highlighted = state.highlightedKeys ??= new Set<string>();
    const validKeys = new Set(keys);
    for (const key of highlighted) if (!validKeys.has(key)) highlighted.delete(key);
    const buttons = new Map<string, HTMLButtonElement>();
    const update = () => {
        for (const [key, button] of buttons) button.setAttribute('aria-pressed', String(highlighted.has(key)));
    };
    const choose = (index: number, modifiers: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {}) => {
        const key = keys[index];
        if (!key) return;
        const anchor = keys.indexOf(state.anchorKey ?? '');
        if (modifiers.shiftKey && anchor >= 0) {
            if (!modifiers.metaKey && !modifiers.ctrlKey) highlighted.clear();
            for (let i = Math.min(anchor, index); i <= Math.max(anchor, index); i++) highlighted.add(keys[i]!);
        } else {
            if (modifiers.metaKey || modifiers.ctrlKey) {
                if (highlighted.has(key)) highlighted.delete(key); else highlighted.add(key);
            } else { highlighted.clear(); highlighted.add(key); }
            state.anchorKey = key;
        }
        update();
    };
    const selectAll = () => {
        for (const key of keys) highlighted.add(key);
        state.anchorKey ??= keys[0];
        update();
    };
    sidebar.addEventListener('keydown', event => {
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'a') {
            event.preventDefault();
            event.stopPropagation();
            selectAll();
        }
    });
    return {
        choose, selectAll,
        addButton(key: string, button: HTMLButtonElement) { buttons.set(key, button); button.setAttribute('aria-pressed', String(highlighted.has(key))); },
        contextTargets(key: string) {
            if (!highlighted.has(key)) choose(keys.indexOf(key));
            buttons.get(key)?.focus({ preventScroll: true });
            return keys.filter(candidate => highlighted.has(candidate));
        },
    };
}

export type PendingRowSelection = ReturnType<typeof createPendingRowSelection>;
