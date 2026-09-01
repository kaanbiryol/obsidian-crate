import React, { useLayoutEffect, useRef } from 'react';
import { Check } from 'lucide-react';

import { BaseModal } from '../../components/BaseModal';
import { AnimationConfig } from '../animations';
import { getProjectColor } from '../../utils/projectColors';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';
import { getPickerModalProps } from '../glassStyles';
import { PickerHeader } from './PickerHeader';
import { REMINDER_PICKER_COPY } from './pickerCopy';

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

export const ProjectDot: React.FC<{ projectName: string }> = ({ projectName }) => {
    const colors = getProjectColor(projectName);

    return (
        <svg className="project-picker-dot" viewBox="0 0 12 12" aria-hidden="true">
            <circle className="project-picker-dot-glow is-light" cx="6" cy="6" r="5" fill={colors.light.accent} />
            <circle className="project-picker-dot-core is-light" cx="6" cy="6" r="5" fill={colors.light.accent} />
            <circle className="project-picker-dot-glow is-dark" cx="6" cy="6" r="5" fill={colors.dark.accent} />
            <circle className="project-picker-dot-core is-dark" cx="6" cy="6" r="5" fill={colors.dark.accent} />
        </svg>
    );
};

interface ProjectRowProps {
    projectName: string;
    isSelected: boolean;
    onSelect: () => void;
    rowRef?: React.Ref<HTMLButtonElement>;
}

const ProjectRow: React.FC<ProjectRowProps> = ({
    projectName,
    isSelected,
    onSelect,
    rowRef,
}) => {
    return (
        <ShadowDOMNativeButton
            ref={rowRef}
            role="option"
            aria-selected={isSelected}
            onClick={onSelect}
            className={`project-picker-row w-full flex items-center gap-3 px-4 min-h-[52px] focus:outline-none${isSelected ? ' is-selected' : ''}`}
        >
            <ProjectDot projectName={projectName} />
            <span
                className={`project-picker-row-label flex-1 text-left truncate${isSelected ? ' is-selected' : ''}`}
            >
                {projectName}
            </span>
            {isSelected && (
                <Check size={18} strokeWidth={2.5} className="project-picker-row-check flex-shrink-0" />
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
