import { getIcon } from 'obsidian';
import { useLayoutEffect, useRef, type ComponentProps } from 'react';
import { ReminderEditorFields } from './ReminderEditorFields';

/** Obsidian's icon registry stays outside the shared editor. */
export function PluginReminderEditorFields(props: ComponentProps<typeof ReminderEditorFields>) {
    const containerRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const container = containerRef.current;
        const icon = getIcon('folder');
        if (!container || !icon) return;

        // Use the same Obsidian icon registry as the project picker button.
        // A mask preserves the chip's theme color without adding editable DOM.
        icon.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        icon.setAttribute('stroke', 'black');
        container.style.setProperty(
            '--crate-project-icon-mask',
            `url("data:image/svg+xml,${encodeURIComponent(icon.outerHTML)}")`,
        );
        return () => {
            container.style.removeProperty('--crate-project-icon-mask');
        };
    }, []);

    return <ReminderEditorFields {...props} containerRef={containerRef} />;
}
