import React, { useRef, useEffect } from 'react';
import { Check, ChevronLeft } from 'lucide-react';

import { BaseModal } from '../BaseModal';
import { AnimationConfig } from '../../ui/animations';
import { getProjectColor } from '../../utils/projectColors';
import { ShadowDOMNativeButton } from '../ShadowDOMButton';
import { softRadialGlow } from '../../ui/gradients';

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

// Color dot component for project indicator with glow halo
export const ProjectDot: React.FC<{ projectName: string; isDark: boolean }> = ({ projectName, isDark }) => {
    const colors = getProjectColor(projectName);
    // Use theme-aware color from the 50-color palette
    const currentColor = isDark ? colors.dark.accent : colors.light.accent;

    return (
        <span
            className="relative flex-shrink-0"
            style={{
                width: '12px',
                height: '12px',
            }}
        >
            {/* Glow halo */}
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
            {/* Dot */}
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

// Project row component - Premium glass card
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

    // Glass styling based on theme
    const glassBackground = isDark
        ? 'rgba(255, 255, 255, 0.015)'
        : 'rgba(0, 0, 0, 0.01)';
    const glassBorder = isDark
        ? 'rgba(255, 255, 255, 0.03)'
        : 'rgba(0, 0, 0, 0.03)';
    const hoverBackground = isDark
        ? 'rgba(255, 255, 255, 0.02)'
        : 'rgba(0, 0, 0, 0.015)';

    return (
        <div style={{ padding: '0 16px', marginBottom: '8px' }}>
            <ShadowDOMNativeButton
                onClick={onSelect}
                className="w-full flex items-center gap-3 px-4 min-h-[52px] focus:outline-none"
                style={{
                    borderRadius: '12px',
                    border: isSelected
                        ? `1px solid var(--interactive-accent)`
                        : `1px solid ${glassBorder}`,
                    background: glassBackground,
                    WebkitTapHighlightColor: 'transparent',
                    boxShadow: isSelected
                        ? `0 0 0 1px var(--interactive-accent), 0 0 10px -6px var(--interactive-accent)`
                        : `0 2px 8px ${isDark ? 'rgba(0, 0, 0, 0.06)' : 'rgba(0, 0, 0, 0.02)'}`,
                    transition: 'transform 200ms ease-out',
                }}
                onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
                    if (!isSelected) {
                        e.currentTarget.style.background = hoverBackground;
                        e.currentTarget.style.borderColor = isDark
                            ? 'rgba(255, 255, 255, 0.1)'
                            : 'rgba(0, 0, 0, 0.08)';
                    }
                }}
                onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
                    if (!isSelected) {
                        e.currentTarget.style.background = glassBackground;
                        e.currentTarget.style.borderColor = glassBorder;
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
                            filter: `drop-shadow(0 0 6px var(--interactive-accent))`,
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

    // Scroll selected item into view when modal opens
    useEffect(() => {
        if (isOpen && scrollContainerRef.current) {
            const selectedIndex = projects.indexOf(selectedProject);
            if (selectedIndex > 0) {
                // Delay slightly to allow modal to render
                const timeout = setTimeout(() => {
                    const container = scrollContainerRef.current;
                    if (container) {
                        const rowHeight = 52;
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

    // Glass styling based on theme
    const glassBackButtonBg = isDark
        ? 'rgba(255, 255, 255, 0.04)'
        : 'rgba(0, 0, 0, 0.03)';
    const glassBackButtonBorder = isDark
        ? 'rgba(255, 255, 255, 0.08)'
        : 'rgba(0, 0, 0, 0.06)';
    const glassBackButtonHoverBg = isDark
        ? 'rgba(255, 255, 255, 0.08)'
        : 'rgba(0, 0, 0, 0.06)';
    return (
        <BaseModal
            isOpen={isOpen}
            onClose={onClose}
            animationConfig={animationConfig}
            variant={pickerMode === 'overlay' ? 'centered' : 'bottom-sheet'}
            performanceMode={pickerMode === 'overlay' ? 'standard' : 'reduced-effects'}
            showBackdrop={false}
            showDragHandle={pickerMode !== 'overlay'}
            zIndex={pickerMode === 'overlay' ? 70 : 60}
        >
            <div className={isDark ? 'dark text-foreground' : ''}>
                {/* Header */}
                <div className="flex items-center justify-between px-5 pt-2 pb-3">
                    {/* Back button - Glass styling */}
                    <ShadowDOMNativeButton
                        onClick={onClose}
                        className="flex items-center justify-center w-9 h-9 rounded-xl transition-all duration-200 active:scale-95"
                        style={{
                            background: glassBackButtonBg,
                            border: `1px solid ${glassBackButtonBorder}`,
                            color: 'var(--text-muted)',
                            boxShadow: `0 2px 8px ${isDark ? 'rgba(0, 0, 0, 0.12)' : 'rgba(0, 0, 0, 0.04)'}`,
                            transition: 'transform 200ms ease-out',
                        }}
                        onMouseEnter={(e: React.MouseEvent<HTMLButtonElement>) => {
                            e.currentTarget.style.background = glassBackButtonHoverBg;
                            e.currentTarget.style.boxShadow = `0 0 12px ${isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.08)'}`;
                        }}
                        onMouseLeave={(e: React.MouseEvent<HTMLButtonElement>) => {
                            e.currentTarget.style.background = glassBackButtonBg;
                            e.currentTarget.style.boxShadow = `0 2px 8px ${isDark ? 'rgba(0, 0, 0, 0.12)' : 'rgba(0, 0, 0, 0.04)'}`;
                        }}
                    >
                        <ChevronLeft size={20} strokeWidth={2} />
                    </ShadowDOMNativeButton>

                    {/* Title - Premium typography */}
                    <span
                        style={{
                            fontSize: '20px',
                            fontWeight: 700,
                            color: 'var(--text-normal)',
                            letterSpacing: '-0.02em',
                        }}
                    >
                        Select Project
                    </span>

                    {/* Spacer for balance */}
                    <div className="w-9" />
                </div>

                {/* Scrollable project list */}
                <div
                    ref={scrollContainerRef}
                    className="project-picker-scroll overflow-y-auto py-3"
                    style={{
                        maxHeight: 'calc(70vh - 100px)',
                        WebkitOverflowScrolling: 'touch',
                        touchAction: 'pan-y',
                    }}
                >
                    <div
                        role="listbox"
                        aria-label="Project selection"
                    >
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
