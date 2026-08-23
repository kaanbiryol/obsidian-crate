import React, { useRef, useEffect } from 'react';
import { Check } from 'lucide-react';

import { BaseModal } from '../../components/BaseModal';
import { AnimationConfig } from '../animations';
import { getProjectColor } from '../../utils/projectColors';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMButton';
import { getPickerModalProps } from '../glassStyles';
import { PickerHeader } from './PickerHeader';

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
}

const ProjectRow: React.FC<ProjectRowProps> = ({
    projectName,
    isSelected,
    onSelect,
}) => {
    return (
        <div className="project-picker-row-wrap">
            <ShadowDOMNativeButton
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
        </div>
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
    const modalProps = getPickerModalProps(pickerMode);

    // Scroll selected item into view when modal opens
    useEffect(() => {
        if (isOpen && scrollContainerRef.current) {
            const selectedIndex = projects.indexOf(selectedProject);
            if (selectedIndex > 0) {
                const timeout = setTimeout(() => {
                    const container = scrollContainerRef.current;
                    if (container) {
                        const rowHeight = 60;
                        const scrollTop = Math.max(0, (selectedIndex * rowHeight) - (container.clientHeight / 2) + (rowHeight / 2));
                        container.scrollTop = scrollTop;
                    }
                }, 50);
                return () => clearTimeout(timeout);
            }
        }
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
            {...modalProps}
        >
            <div className={isDark ? 'dark' : ''}>
                <PickerHeader
                    onBack={onClose}
                    title="Select Project"
                />

                {/* Project List */}
                <div
                    ref={scrollContainerRef}
                    className="project-picker-scroll overflow-y-auto py-3"
                >
                    <div role="listbox" aria-label="Project selection">
                        {projects.map((p) => (
                            <ProjectRow
                                key={p}
                                projectName={p}
                                isSelected={p === selectedProject}
                                onSelect={() => handleSelectProject(p)}
                            />
                        ))}
                    </div>
                </div>
            </div>
        </BaseModal>
    );
};
