import React, { useLayoutEffect, useRef } from 'react';

import { BaseModal } from '../../components/BaseModal';
import { AnimationConfig } from '../animations';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';
import { getPickerModalProps } from '../glassStyles';
import { PickerHeader } from './PickerHeader';
import { REMINDER_PICKER_COPY } from './pickerCopy';
import { ObsidianIcon } from '../../components/obsidian-icon';
import { ProjectDot } from './ProjectDot';

interface ProjectPickerModalProps {
    isOpen: boolean;
    onClose: () => void;
    animationConfig: AnimationConfig;
    pickerMode: 'replace' | 'overlay';
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
        <ShadowDOMNativeButton
            ref={rowRef}
            role="option"
            aria-selected={isSelected}
            onClick={onSelect}
            className={`project-picker-row w-full flex items-center gap-3 px-4 min-h-[52px]${isSelected ? ' is-selected' : ''}`}
        >
            <ProjectDot projectName={projectName} isDark={isDark} />
            <span
                className={`project-picker-row-label flex-1 text-left truncate${isSelected ? ' is-selected' : ''}`}
            >
                {projectName}
            </span>
            {isSelected && (
                <ObsidianIcon size="m" id="check" className="project-picker-row-check flex-shrink-0" />
            )}
        </ShadowDOMNativeButton>
    );
};

export const ProjectPickerModal: React.FC<ProjectPickerModalProps> = ({
    isOpen,
    onClose,
    animationConfig,
    pickerMode,
    projects,
    project,
    defaultProject,
    isDark,
    onSelectProject,
}) => {
    const selectedProject = project || defaultProject || 'Inbox';
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const selectedRowRef = useRef<HTMLButtonElement>(null);
    const modalProps = getPickerModalProps(pickerMode);

    // Scroll selected item into view when modal opens
    useLayoutEffect(() => {
        const container = scrollContainerRef.current;
        const selectedRow = selectedRowRef.current;
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
    }, [isOpen, projects, selectedProject]);

    const handleSelectProject = (projectName: string) => {
        onSelectProject(projectName);
        onClose();
    };

    return (
        <BaseModal
            isOpen={isOpen}
            onClose={onClose}
            animationConfig={animationConfig}
            className="crate-reminder-picker-surface is-project-picker"
            {...modalProps}
        >
            <div className={`reminder-picker reminder-project-picker${isDark ? ' dark' : ''}`}>
                <PickerHeader
                    onBack={onClose}
                    closeLabel={REMINDER_PICKER_COPY.project.closeLabel}
                    title={REMINDER_PICKER_COPY.project.title}
                />

                {/* Project List */}
                <div
                    ref={scrollContainerRef}
                    className="project-picker-scroll overflow-y-auto"
                >
                    <div className="project-picker-list" role="listbox" aria-label={REMINDER_PICKER_COPY.project.listLabel}>
                        {projects.map((p) => (
                            <ProjectRow
                                key={p}
                                projectName={p}
                                isSelected={p === selectedProject}
                                isDark={isDark}
                                rowRef={p === selectedProject ? selectedRowRef : undefined}
                                onSelect={() => handleSelectProject(p)}
                            />
                        ))}
                    </div>
                </div>
            </div>
        </BaseModal>
    );
};
