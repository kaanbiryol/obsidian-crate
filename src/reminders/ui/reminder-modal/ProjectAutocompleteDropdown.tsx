import React, { useRef, useEffect } from 'react';

import { useObsidianDarkMode } from '../hooks/useObsidianDarkMode';
import { ProjectDot } from './ProjectDot';

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
        if (!scrollRef.current) return;
        const highlighted = scrollRef.current.children[highlightedIndex] as HTMLElement | undefined;
        highlighted?.scrollIntoView({ block: 'nearest' });
    }, [highlightedIndex]);

    if (filteredProjects.length === 0 || !anchorRect || !containerRef.current) {
        return null;
    }

    const containerRect = containerRef.current.getBoundingClientRect();
    const top = anchorRect.bottom - containerRect.top + 6;

    return (
        <div
            ref={scrollRef}
            onMouseDown={(e) => e.preventDefault()}
            className="project-autocomplete-dropdown"
            id="project-autocomplete-listbox"
            role="listbox"
            aria-label="Project suggestions"
            style={{ top }}
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
