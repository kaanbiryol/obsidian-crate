import React, { useLayoutEffect, useRef } from 'react';

import { ModalHeader } from '../../../ui/shared/ModalHeader';
import { Toolbar } from '@base-ui/react/toolbar';
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
}

const ProjectRow: React.FC<ProjectRowProps> = ({
    projectName,
    isSelected,
    isDark,
    onSelect,
    rowRef,
}) => {
    return (
        <Toolbar.Button
            ref={rowRef}
            data-action="select-project"
            data-project={projectName}
            role="option"
            aria-selected={isSelected}
            onClick={onSelect}
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
        </Toolbar.Button>
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
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const rowRefs = useRef(new Map<number, HTMLButtonElement>());

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
            />

            {/* Project List */}
            <div
                ref={scrollContainerRef}
                className="project-picker-scroll"
                onWheel={(event) => event.stopPropagation()}
                onTouchMove={(event) => event.stopPropagation()}
            >
                <Toolbar.Root orientation="vertical" className="project-picker-list" role="listbox" aria-label={REMINDER_PICKER_COPY.project.listLabel}>
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
                            onSelect={() => handleSelectProject(p)}
                        />
                    ))}
                </Toolbar.Root>
            </div>
        </div>
    );
};
