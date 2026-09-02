import React, { useRef, useEffect } from 'react';

import { useObsidianDarkMode } from '../hooks/useObsidianDarkMode';
import { ProjectDot } from './ProjectDot';

const DROPDOWN_MAX_HEIGHT = 224;
const DROPDOWN_ROW_HEIGHT = 42;
const DROPDOWN_PADDING = 12;
const DROPDOWN_GAP = 8;
const SURFACE_GUTTER = 10;

interface ProjectAutocompleteDropdownProps {
    filteredProjects: string[];
    highlightedIndex: number;
    anchorRect: DOMRect | null;
    containerRef: React.RefObject<HTMLElement | null>;
    onSelect: (project: string) => void;
}

export const ProjectAutocompleteDropdown: React.FC<ProjectAutocompleteDropdownProps> = ({
    filteredProjects,
    highlightedIndex,
    anchorRect,
    containerRef,
    onSelect,
}) => {
    const scrollRef = useRef<HTMLDivElement>(null);
    const isDark = useObsidianDarkMode();

    useEffect(() => {
        const scrollContainer = scrollRef.current;
        if (!scrollContainer) return;

        const highlighted = scrollContainer.children[highlightedIndex] as HTMLElement | undefined;
        if (!highlighted) return;

        // Keep keyboard navigation local to the suggestions. scrollIntoView()
        // also scrolls outer ancestors, which moves the reminder editor behind it.
        const containerRect = scrollContainer.getBoundingClientRect();
        const highlightedRect = highlighted.getBoundingClientRect();
        const scrollInset = DROPDOWN_PADDING / 2;
        if (highlightedRect.top < containerRect.top + scrollInset) {
            scrollContainer.scrollTop += highlightedRect.top - containerRect.top - scrollInset;
        } else if (highlightedRect.bottom > containerRect.bottom - scrollInset) {
            scrollContainer.scrollTop += highlightedRect.bottom - containerRect.bottom + scrollInset;
        }
    }, [highlightedIndex]);

    if (filteredProjects.length === 0 || !anchorRect || !containerRef.current) {
        return null;
    }

    const containerRect = containerRef.current.getBoundingClientRect();
    const horizontalGutter = containerRect.width <= 600 ? 18 : 26;
    const availableWidth = Math.max(0, containerRect.width - (horizontalGutter * 2));
    const width = Math.min(320, availableWidth);
    const anchorLeft = anchorRect.left - containerRect.left;
    const maxLeft = Math.max(horizontalGutter, containerRect.width - horizontalGutter - width);
    const left = Math.min(Math.max(anchorLeft, horizontalGutter), maxLeft);
    const surfaceRect = containerRef.current
        .closest<HTMLElement>('.base-modal-surface')
        ?.getBoundingClientRect();
    const boundaryTop = surfaceRect?.top ?? 0;
    const boundaryBottom = surfaceRect?.bottom ?? window.innerHeight;
    const availableBelow = Math.max(
        0,
        boundaryBottom - anchorRect.bottom - DROPDOWN_GAP - SURFACE_GUTTER,
    );
    const availableAbove = Math.max(
        0,
        anchorRect.top - boundaryTop - DROPDOWN_GAP - SURFACE_GUTTER,
    );
    const desiredHeight = Math.min(
        DROPDOWN_MAX_HEIGHT,
        (filteredProjects.length * DROPDOWN_ROW_HEIGHT) + DROPDOWN_PADDING,
    );
    const openAbove = availableBelow < desiredHeight && availableAbove > availableBelow;
    const maxHeight = Math.min(
        DROPDOWN_MAX_HEIGHT,
        openAbove ? availableAbove : availableBelow,
    );
    const verticalPosition: React.CSSProperties = openAbove
        ? { bottom: containerRect.bottom - anchorRect.top + DROPDOWN_GAP }
        : { top: anchorRect.bottom - containerRect.top + DROPDOWN_GAP };

    return (
        <div
            ref={scrollRef}
            onMouseDown={(e) => e.preventDefault()}
            onWheel={(event) => event.stopPropagation()}
            onTouchMove={(event) => event.stopPropagation()}
            className="project-autocomplete-dropdown"
            id="project-autocomplete-listbox"
            role="listbox"
            aria-label="Project suggestions"
            data-placement={openAbove ? 'top' : 'bottom'}
            style={{ left, width, maxHeight, ...verticalPosition }}
        >
            {filteredProjects.map((project, index) => (
                <div
                    key={project}
                    id={`project-autocomplete-option-${index}`}
                    onClick={() => onSelect(project)}
                    role="option"
                    aria-selected={index === highlightedIndex}
                    className="project-autocomplete-option"
                >
                    <ProjectDot projectName={project} isDark={isDark} />
                    <span className="project-autocomplete-label">
                        {project}
                    </span>
                </div>
            ))}
        </div>
    );
};
