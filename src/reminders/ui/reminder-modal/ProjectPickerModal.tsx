import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { BaseModal } from '../../components/BaseModal';
import { AnimationConfig } from '../animations';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';
import { getPickerModalProps } from '../glassStyles';
import { PickerHeader } from './PickerHeader';
import { REMINDER_PICKER_COPY } from './pickerCopy';
import { ObsidianIcon } from '../../components/obsidian-icon';
import { ProjectDot } from './ProjectDot';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';

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
        <ShadowDOMNativeButton
            ref={rowRef}
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
                <ObsidianIcon size="m" id="check" className="project-picker-row-check" />
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
    const reduceMotion = useObsidianReducedMotion();
    const selectedProject = project || defaultProject || 'Inbox';
    const selectedIndex = Math.max(0, projects.indexOf(selectedProject));
    const [activeIndex, setActiveIndex] = useState(selectedIndex);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const rowRefs = useRef(new Map<number, HTMLButtonElement>());
    const modalProps = getPickerModalProps(pickerMode);

    useEffect(() => {
        if (isOpen) setActiveIndex(selectedIndex);
    }, [isOpen, selectedIndex]);

    // Scroll selected item into view when modal opens
    useLayoutEffect(() => {
        const container = scrollContainerRef.current;
        const activeRow = rowRefs.current.get(activeIndex);
        if (!isOpen || !container || !activeRow) return;

        const containerRect = container.getBoundingClientRect();
        const rowRect = activeRow.getBoundingClientRect();
        container.scrollTop = Math.max(
            0,
            container.scrollTop
                + rowRect.top
                - containerRect.top
                - ((container.clientHeight - rowRect.height) / 2),
        );
    }, [activeIndex, isOpen, projects]);

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
        <BaseModal
            isOpen={isOpen}
            onClose={onClose}
            animationConfig={animationConfig}
            className={`crate-reminder-picker-surface is-project-picker${reduceMotion ? ' is-reduced-motion' : ''}`}
            ariaLabel={REMINDER_PICKER_COPY.project.dialogLabel}
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
                    className="project-picker-scroll"
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
        </BaseModal>
    );
};
