import React, { useRef, useEffect } from 'react';
import { Check } from 'lucide-react';

import { BaseModal } from '../BaseModal';
import { AnimationConfig } from '../../ui/animations';
import { getProjectColor } from '../../utils/projectColors';
import { ShadowDOMNativeButton } from '../ShadowDOMButton';
import { softRadialGlow } from '../../ui/gradients';
import { getGlassColors, getPickerModalProps } from '../../ui/glassStyles';
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

export const ProjectDot: React.FC<{ projectName: string; isDark: boolean }> = ({ projectName, isDark }) => {
    const colors = getProjectColor(projectName);
    const currentColor = isDark ? colors.dark.accent : colors.light.accent;

    return (
        <span
            className="relative flex-shrink-0"
            style={{ width: '12px', height: '12px' }}
        >
            <span
                style={{
                    position: 'absolute',
                    inset: '-4px',
                    borderRadius: '50%',
                    backgroundImage: `${softRadialGlow(currentColor, { shape: 'circle', strength: 0.2, spread: 0.8 })}, var(--reminders-noise)`,
                    backgroundRepeat: 'no-repeat, repeat',
                    backgroundSize: 'auto, var(--reminders-noise-size)',
                    backgroundBlendMode: 'screen',
                    opacity: isDark ? 0.6 : 0.4,
                    filter: 'blur(2px)',
                }}
            />
            <span
                style={{
                    position: 'absolute',
                    inset: '1px',
                    borderRadius: '50%',
                    backgroundColor: currentColor,
                }}
            />
        </span>
    );
};

interface ProjectRowProps {
    projectName: string;
    isSelected: boolean;
    onSelect: () => void;
    isDark: boolean;
}

const ProjectRow: React.FC<ProjectRowProps> = ({
    projectName,
    isSelected,
    onSelect,
    isDark,
}) => {
    const glass = getGlassColors(isDark);

    return (
        <div style={{ padding: '0 16px', marginBottom: '8px' }}>
            <ShadowDOMNativeButton
                onClick={onSelect}
                className="w-full flex items-center gap-3 px-4 min-h-[52px] focus:outline-none"
                style={{
                    borderRadius: '12px',
                    border: isSelected
                        ? '1px solid var(--interactive-accent)'
                        : `1px solid ${glass.surface.border}`,
                    background: glass.surface.bg,
                    WebkitTapHighlightColor: 'transparent',
                    boxShadow: isSelected
                        ? '0 0 0 1px var(--interactive-accent), 0 0 10px -6px var(--interactive-accent)'
                        : `0 2px 8px ${isDark ? 'rgba(0, 0, 0, 0.06)' : 'rgba(0, 0, 0, 0.02)'}`,
                    transition: 'transform 200ms ease-out',
                }}
                onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
                    if (!isSelected) {
                        e.currentTarget.style.background = glass.surfaceHover.bg;
                        e.currentTarget.style.borderColor = glass.surfaceHover.border;
                    }
                }}
                onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
                    if (!isSelected) {
                        e.currentTarget.style.background = glass.surface.bg;
                        e.currentTarget.style.borderColor = glass.surface.border;
                    }
                }}
            >
                <ProjectDot projectName={projectName} isDark={isDark} />
                <span
                    className="flex-1 text-left truncate"
                    style={{
                        fontSize: '15px',
                        fontWeight: isSelected ? 600 : 500,
                        lineHeight: 1.4,
                        letterSpacing: '-0.01em',
                        color: 'var(--text-normal)',
                    }}
                >
                    {projectName}
                </span>
                {isSelected && (
                    <Check
                        size={18}
                        strokeWidth={2.5}
                        style={{
                            color: 'var(--interactive-accent)',
                            filter: 'drop-shadow(0 0 6px var(--interactive-accent))',
                        }}
                        className="flex-shrink-0"
                    />
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
            <div className={isDark ? 'dark text-foreground' : ''}>
                <PickerHeader
                    onBack={onClose}
                    isDark={isDark}
                    title="Select Project"
                />

                {/* Project List */}
                <div
                    ref={scrollContainerRef}
                    className="project-picker-scroll overflow-y-auto py-3"
                    style={{
                        maxHeight: 'calc(70vh - 100px)',
                        WebkitOverflowScrolling: 'touch',
                        touchAction: 'pan-y',
                    }}
                >
                    <div role="listbox" aria-label="Project selection">
                        {projects.map((p) => (
                            <ProjectRow
                                key={p}
                                projectName={p}
                                isSelected={p === selectedProject}
                                onSelect={() => handleSelectProject(p)}
                                isDark={isDark}
                            />
                        ))}
                    </div>
                </div>
            </div>
        </BaseModal>
    );
};
