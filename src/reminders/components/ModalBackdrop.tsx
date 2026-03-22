import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { prefersReducedMotion } from '../ui/animations';
import type { AnimationConfig } from '../types/componentAdapter';

interface ModalBackdropProps {
    /** Controls backdrop visibility */
    isVisible: boolean;
    /** Z-index for the backdrop layer */
    zIndex?: number;
    /** Animation configuration */
    animationConfig?: AnimationConfig;
    /** Optional click handler for backdrop dismiss */
    onClick?: () => void;
    /** Custom className for styling */
    className?: string;
    /** Called when exit animation completes */
    onExitComplete?: () => void;
}

/**
 * Shared persistent backdrop component for modal systems.
 *
 * Benefits:
 * - Single backdrop renders once, preventing stacking issues
 * - Controlled via `isVisible` prop from parent modal coordinator
 * - Smooth fade in/out synchronized with modal transitions
 * - Supports click-to-dismiss via onClick prop
 *
 * Usage:
 * - Render once at the top level of your modal system
 * - Control visibility based on whether any modal is open
 * - Pass onClick to dismiss all modals when backdrop is tapped
 */
export const ModalBackdrop: React.FC<ModalBackdropProps> = ({
    isVisible,
    zIndex = 59,
    animationConfig = { enabled: true },
    onClick,
    className = '',
    onExitComplete,
}) => {
    const isAnimationEnabled = animationConfig.enabled && !prefersReducedMotion();

    return (
        <AnimatePresence onExitComplete={onExitComplete}>
            {isVisible && (
                <motion.div
                    key="shared-backdrop"
                    initial={isAnimationEnabled ? { opacity: 0 } : { opacity: 1 }}
                    animate={{ opacity: 1 }}
                    exit={isAnimationEnabled ? { opacity: 0 } : { opacity: 1 }}
                    transition={isAnimationEnabled ? {
                        duration: 0.33,
                        ease: [0.32, 0.72, 0, 1] // easeOut - smooth perceptual fade
                    } : { duration: 0 }}
                    className={`fixed inset-0 bg-black/50 ${className}`}
                    style={{
                        zIndex,
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        willChange: 'opacity',
                        pointerEvents: onClick ? 'auto' : 'none',
                    }}
                    onClick={onClick}
                    onTouchStart={onClick ? (e) => { e.preventDefault(); onClick(); } : undefined}
                />
            )}
        </AnimatePresence>
    );
};
