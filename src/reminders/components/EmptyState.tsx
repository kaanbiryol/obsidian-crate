import React from 'react';
import { motion } from 'framer-motion';
import type { AnimationConfig } from '../types/componentAdapter';
import { EASE_EXPO_OUT, EASE_STANDARD, CONTENT_TRANSITION_DURATION } from '../ui/layoutConstants';

interface EmptyStateProps {
    icon: React.ComponentType<{ size?: number; className?: string }>;
    title: string;
    description: string;
    iconColor?: 'primary' | 'secondary' | 'warning';
    animationConfig?: AnimationConfig;
    /** Use tighter spacing for compact views like sidebars */
    compact?: boolean;
}

/**
 * Reusable empty state component with icon, title, and description.
 */
export const EmptyState: React.FC<EmptyStateProps> = ({
    icon: Icon,
    title,
    description,
    iconColor = 'primary',
    animationConfig = { enabled: true },
    compact = false
}) => {
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
    const Wrapper = animationConfig.enabled ? motion.div : 'div';
    const IconWrapper = animationConfig.enabled ? motion.div : 'div';

    const wrapperProps = animationConfig.enabled ? {
        initial: 'hidden',
        animate: 'visible',
        exit: 'exit',
        variants
    } : {};

    const iconMotionProps = animationConfig.enabled ? {
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: { duration, delay: 0.05, ease: EASE_EXPO_OUT } }
    } : {};

    const iconInnerSize = compact ? 26 : 40;

    return (
        <Wrapper
            {...wrapperProps}
            className={`reminders-empty-state flex flex-col flex-1 items-center justify-center text-center w-full h-full${compact ? ' is-compact' : ''}`}
        >
            <IconWrapper
                {...iconMotionProps}
                className={`reminders-empty-state-icon tone-${iconColor} flex items-center justify-center rounded-full`}
            >
                <Icon size={iconInnerSize} className="reminders-empty-state-glyph" />
            </IconWrapper>
            <h3 className="reminders-empty-state-title">
                {title}
            </h3>
            <p className="reminders-empty-state-description">
                {description}
            </p>
        </Wrapper>
    );
};
