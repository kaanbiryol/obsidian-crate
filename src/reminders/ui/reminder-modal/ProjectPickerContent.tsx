import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { ModalHeader } from '../../../ui/shared/ModalHeader';
import { Button } from '../../../ui/shared/Button';
import { REMINDER_PICKER_COPY } from './pickerCopy';
import { ThemeIcon } from '../../components/theme-icon';
import { ProjectDot } from './ProjectDot';

interface ProjectPickerContentProps {
    isOpen: boolean;
    onClose: () => void;
    projects: string[];
    project: string;
    defaultProject: string;
    isDark: boolean;
    onSelectProject: (project: string) => void;
}

interface ProjectRowProps {
    projectName: string;
    isSelected: boolean;
    isDark: boolean;
    onSelect: () => void;
    rowRef?: React.Ref<HTMLButtonElement>;
    tabIndex: number;
    onFocus: () => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}

const ProjectRow: React.FC<ProjectRowProps> = ({
    projectName,
    isSelected,
    isDark,
    onSelect,
    rowRef,
    tabIndex,
    onFocus,
    onKeyDown,
}) => {
    return (
        <Button
            ref={rowRef}
            data-action="select-project"
            data-project={projectName}
            role="option"
            aria-selected={isSelected}
            tabIndex={tabIndex}
            onClick={onSelect}
            onFocus={onFocus}
            onKeyDown={onKeyDown}
            className={`project-picker-row${isSelected ? ' is-selected' : ''}`}
        >
            <ProjectDot projectName={projectName} isDark={isDark} />
            <span
                className={`project-picker-row-label${isSelected ? ' is-selected' : ''}`}
            >
                {projectName}
            </span>
            {isSelected && (
                <ThemeIcon size="s" id="check" className="project-picker-row-check" />
            )}
        </Button>
    );
};

export const ProjectPickerContent: React.FC<ProjectPickerContentProps> = ({
    isOpen,
    onClose,
    projects,
    project,
    defaultProject,
    isDark,
    onSelectProject,
}) => {
    const selectedProject = project || defaultProject || 'Inbox';
    const selectedIndex = Math.max(0, projects.indexOf(selectedProject));
    const [activeIndex, setActiveIndex] = useState(selectedIndex);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const rowRefs = useRef(new Map<number, HTMLButtonElement>());

    useEffect(() => {
        if (isOpen) setActiveIndex(selectedIndex);
    }, [isOpen, selectedIndex]);

    // Center the selection on open, not on row focus: pointer focus happens
    // before click, so moving the row at that point can cancel selection.
    useLayoutEffect(() => {
        const container = scrollContainerRef.current;
        const selectedRow = rowRefs.current.get(selectedIndex);
        if (!isOpen || !container || !selectedRow) return;

        const containerRect = container.getBoundingClientRect();
        const rowRect = selectedRow.getBoundingClientRect();
        container.scrollTop = Math.max(
            0,
            container.scrollTop
                + rowRect.top
                - containerRect.top
                - ((container.clientHeight - rowRect.height) / 2),
        );
    }, [selectedIndex, isOpen, projects]);

    const focusIndex = useCallback((index: number) => {
        if (projects.length === 0) return;
        const nextIndex = Math.min(projects.length - 1, Math.max(0, index));
        setActiveIndex(nextIndex);
        rowRefs.current.get(nextIndex)?.focus();
    }, [projects.length]);

    const handleRowKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
        let nextIndex: number | null = null;
        if (event.key === 'ArrowDown') nextIndex = (index + 1) % projects.length;
        if (event.key === 'ArrowUp') nextIndex = (index - 1 + projects.length) % projects.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = projects.length - 1;
        if (nextIndex === null) return;
        event.preventDefault();
        focusIndex(nextIndex);
    }, [focusIndex, projects.length]);

    const handleSelectProject = (projectName: string) => {
        onSelectProject(projectName);
        onClose();
    };

    return (
        <div className={`reminder-picker reminder-project-picker${isDark ? ' dark' : ''}`}>
            <ModalHeader
                onClose={onClose}
                closeLabel={REMINDER_PICKER_COPY.project.closeLabel}
                title={REMINDER_PICKER_COPY.project.title}
                action={{ label: REMINDER_PICKER_COPY.project.done, onClick: onClose }}
            />

            {/* Project List */}
            <div
                ref={scrollContainerRef}
                className="project-picker-scroll"
                onWheel={(event) => event.stopPropagation()}
                onTouchMove={(event) => event.stopPropagation()}
            >
                <div className="project-picker-list" role="listbox" aria-label={REMINDER_PICKER_COPY.project.listLabel}>
                    {projects.map((p, index) => (
                        <ProjectRow
                            key={p}
                            projectName={p}
                            isSelected={p === selectedProject}
                            isDark={isDark}
                            rowRef={(element) => {
                                if (element) rowRefs.current.set(index, element);
                                else rowRefs.current.delete(index);
                            }}
                            tabIndex={index === activeIndex ? 0 : -1}
                            onFocus={() => setActiveIndex(index)}
                            onKeyDown={(event) => handleRowKeyDown(event, index)}
                            onSelect={() => handleSelectProject(p)}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
};
