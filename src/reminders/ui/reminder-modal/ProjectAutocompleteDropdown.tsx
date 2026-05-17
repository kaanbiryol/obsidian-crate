import React, { useRef, useEffect } from 'react';

import { ProjectDot } from './ProjectPickerModal';

interface ProjectAutocompleteDropdownProps {
    filteredProjects: string[];
    highlightedIndex: number;
    anchorRect: DOMRect | null;
    containerRef: React.RefObject<HTMLElement | null>;
    isDark: boolean;
    onSelect: (project: string) => void;
}

export const ProjectAutocompleteDropdown: React.FC<ProjectAutocompleteDropdownProps> = ({
    filteredProjects,
    highlightedIndex,
    anchorRect,
    containerRef,
    isDark,
    onSelect,
}) => {
    const scrollRef = useRef<HTMLDivElement>(null);

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

    const highlightBg = isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.05)';
    const separatorColor = isDark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.04)';

    return (
        <div
            ref={scrollRef}
            onMouseDown={(e) => e.preventDefault()}
            style={{
                position: 'absolute',
                top,
                left: 0,
                right: 0,
                zIndex: 100,
                maxHeight: '192px',
                overflowY: 'auto',
                background: isDark ? 'var(--background-secondary)' : 'var(--background-primary)',
                borderBottom: `1px solid ${separatorColor}`,
                borderLeft: `1px solid ${separatorColor}`,
                borderRight: `1px solid ${separatorColor}`,
                borderRadius: '0 0 12px 12px',
                boxShadow: isDark
                    ? '0 4px 12px rgba(0, 0, 0, 0.3)'
                    : '0 4px 12px rgba(0, 0, 0, 0.08)',
            }}
        >
            {filteredProjects.map((project, index) => (
                <div
                    key={project}
                    onClick={() => onSelect(project)}
                    role="option"
                    aria-selected={index === highlightedIndex}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        padding: '8px 14px',
                        background: index === highlightedIndex ? highlightBg : 'transparent',
                        borderBottom: index < filteredProjects.length - 1
                            ? `1px solid ${separatorColor}`
                            : 'none',
                        cursor: 'pointer',
                    }}
                >
                    <ProjectDot projectName={project} isDark={isDark} />
                    <span
                        style={{
                            fontSize: '13px',
                            fontWeight: 500,
                            color: 'var(--text-normal)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {project}
                    </span>
                </div>
            ))}
        </div>
    );
};
