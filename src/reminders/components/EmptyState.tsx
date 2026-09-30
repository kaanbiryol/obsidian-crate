import React, { createContext, useContext, useRef } from 'react';
import { motion, useIsPresent } from 'motion/react';
import type { AnimationConfig } from '../types/componentAdapter';
import { REMINDER_LIST_FADE_TRANSITION } from '../ui/layoutConstants';
import { ThemeIcon } from './theme-icon';
import { useObsidianReducedMotion } from '../ui/useObsidianReducedMotion';

interface EmptyStateProps {
    icon: string;
    title: string;
    description: React.ReactNode;
    className?: string;
    children?: React.ReactNode;
    iconColor?: 'primary' | 'secondary' | 'warning';
    animationConfig?: AnimationConfig;
    /** Use tighter spacing for compact views like sidebars */
    compact?: boolean;
}

/** Hosts with incomplete data can replace conclusive empty-state messages. */
export const EmptyStateMessageContext = createContext<{ title: string; description: string } | null>(null);

/**
 * Reusable empty state component with icon, title, and description.
 */
export const EmptyState: React.FC<EmptyStateProps> = ({
    icon,
    title,
    description,
    iconColor = 'primary',
    animationConfig = { enabled: true },
    compact = false,
    className = '',
    children,
}) => {
	const currentMessage = useContext(EmptyStateMessageContext);
	const isPresent = useIsPresent();
	const lastMessage = useRef(currentMessage);
	// Preserve loading copy while this state exits to reveal newly loaded cards.
	if (isPresent) lastMessage.current = currentMessage;
	const message = isPresent ? currentMessage : lastMessage.current;
    const reduceMotion = useObsidianReducedMotion();
    const animationsEnabled = animationConfig.enabled && !reduceMotion;
    const duration = animationConfig.duration ?? REMINDER_LIST_FADE_TRANSITION.duration;
    const variants = {
        hidden: { opacity: 0 },
        visible: {
            opacity: 1,
            transition: { duration, ease: REMINDER_LIST_FADE_TRANSITION.ease }
        },
        exit: {
            opacity: 0,
            transition: { ...REMINDER_LIST_FADE_TRANSITION }
        }
    };

    // Conditional wrapper for animations
    const Wrapper = animationsEnabled ? motion.div : 'div';

    const wrapperProps = animationsEnabled ? {
        initial: 'hidden',
        animate: 'visible',
        exit: 'exit',
        variants
    } : {};

    return (
        <Wrapper
            {...wrapperProps}
            className={`reminders-empty-state${compact ? ' is-compact' : ''}${className ? ` ${className}` : ''}`}
        >
            <div
                className={`reminders-empty-state-icon tone-${iconColor} flex items-center justify-center rounded-full`}
            >
                <ThemeIcon size={compact ? "l" : "xl"} id={icon} className="reminders-empty-state-glyph" />
            </div>
            <h3 className="reminders-empty-state-title">
                {message?.title ?? title}
            </h3>
            <p className="reminders-empty-state-description">
                {message?.description ?? description}
            </p>
            {children && <div className="reminders-empty-state-actions">{children}</div>}
        </Wrapper>
    );
};
