import React, { createContext, useContext } from 'react';
import { motion } from 'motion/react';
import type { AnimationConfig } from '../types/componentAdapter';
import { EASE_EXPO_OUT, EASE_STANDARD, CONTENT_TRANSITION_DURATION } from '../ui/layoutConstants';
import { ThemeIcon } from './theme-icon';
import { useObsidianReducedMotion } from '../ui/useObsidianReducedMotion';

interface EmptyStateProps {
    icon: string;
    title: string;
    description: string;
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
    compact = false
}) => {
	const message = useContext(EmptyStateMessageContext);
    const reduceMotion = useObsidianReducedMotion();
    const animationsEnabled = animationConfig.enabled && !reduceMotion;
    const duration = animationConfig.duration ?? CONTENT_TRANSITION_DURATION;
    const variants = {
        hidden: { opacity: 0 },
        visible: {
            opacity: 1,
            transition: { duration, ease: EASE_EXPO_OUT }
        },
        exit: {
            opacity: 0,
            transition: { duration: 0.2, ease: EASE_STANDARD }
        }
    };

    // Conditional wrapper for animations
    const Wrapper = animationsEnabled ? motion.div : 'div';
    const IconWrapper = animationsEnabled ? motion.div : 'div';

    const wrapperProps = animationsEnabled ? {
        initial: 'hidden',
        animate: 'visible',
        exit: 'exit',
        variants
    } : {};

    const iconMotionProps = animationsEnabled ? {
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: { duration, delay: 0.05, ease: EASE_EXPO_OUT } }
    } : {};

    return (
        <Wrapper
            {...wrapperProps}
            className={`reminders-empty-state flex flex-col flex-1 items-center justify-center text-center w-full h-full${compact ? ' is-compact' : ''}`}
        >
            <IconWrapper
                {...iconMotionProps}
                className={`reminders-empty-state-icon tone-${iconColor} flex items-center justify-center rounded-full`}
            >
                <ThemeIcon size={compact ? "l" : "xl"} id={icon} className="reminders-empty-state-glyph" />
            </IconWrapper>
            <h3 className="reminders-empty-state-title">
                {message?.title ?? title}
            </h3>
            <p className="reminders-empty-state-description">
                {message?.description ?? description}
            </p>
        </Wrapper>
    );
};
