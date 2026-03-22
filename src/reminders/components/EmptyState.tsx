import React from 'react';
import { motion, type Easing } from 'framer-motion';
import type { AnimationConfig } from '../types/componentAdapter';
import { getFontSize, getFontWeight } from '../ui/themes';
import { EASE_EXPO_OUT, EASE_STANDARD, CONTENT_TRANSITION_DURATION } from '../ui/layoutConstants';

// Cast easing arrays to framer-motion compatible type
const easeExpoOut = EASE_EXPO_OUT as unknown as Easing;
const easeStandard = EASE_STANDARD as unknown as Easing;

interface EmptyStateProps {
    icon: React.ComponentType<{ size?: number; className?: string }>;
    title: string;
    description: string;
    iconColor?: string;
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
            transition: { duration, ease: easeExpoOut }
        },
        exit: {
            opacity: 0,
            transition: { duration: 0.2, ease: easeStandard }
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
        animate: { opacity: 1, transition: { duration, delay: 0.05, ease: easeExpoOut } }
    } : {};

    const textColor = { color: 'var(--text-normal)' };
    const mutedColor = { color: 'var(--text-muted)' };

    // Use inline styles for spacing to ensure they work in the plugin (no Tailwind)
    const iconSize = compact ? 56 : 88;
    const iconInnerSize = compact ? 26 : 40;
    const iconMarginBottom = compact ? 8 : 10;
    // Use Obsidian font sizes
    const titleFontSize = compact ? getFontSize('base') : getFontSize('lg');
    const titleMarginBottom = compact ? 4 : 4;
    const descFontSize = compact ? getFontSize('sm') : getFontSize('base');
    const wrapperGap = compact ? 4 : 4;
    const wrapperPaddingX = compact ? 20 : 28;
    const textMaxWidth = compact ? 240 : 320;

    return (
        <Wrapper
            {...wrapperProps}
            className="flex flex-col flex-1 items-center justify-center text-center w-full h-full"
            style={{
                paddingLeft: wrapperPaddingX,
                paddingRight: wrapperPaddingX,
                gap: wrapperGap
            }}
        >
            <IconWrapper
                {...iconMotionProps}
                className={`flex items-center justify-center rounded-full bg-${iconColor}/10`}
                style={{
                    width: iconSize,
                    height: iconSize,
                    flexShrink: 0,
                    marginBottom: iconMarginBottom
                }}
            >
                <Icon size={iconInnerSize} className={`text-${iconColor}`} />
            </IconWrapper>
            <h3
                style={{
                    ...textColor,
                    fontSize: titleFontSize,
                    fontWeight: getFontWeight('semibold'),
                    margin: 0,
                    marginBottom: titleMarginBottom,
                    lineHeight: 1.3,
                    maxWidth: textMaxWidth
                }}
            >
                {title}
            </h3>
            <p
                style={{
                    ...mutedColor,
                    fontSize: descFontSize,
                    margin: 0,
                    lineHeight: 1.5,
                    maxWidth: textMaxWidth
                }}
            >
                {description}
            </p>
        </Wrapper>
    );
};
