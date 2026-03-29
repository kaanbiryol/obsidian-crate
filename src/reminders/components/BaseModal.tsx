import React, { useCallback, useState } from 'react';
import { motion, AnimatePresence, PanInfo, useMotionValue, useTransform } from 'framer-motion';
import type { AnimationConfig, ModalVariant } from '../types/componentAdapter';
import {
    prefersReducedMotion,
    IOS_SPRING,
    IOS_EXIT,
    BACKDROP_ANIMATION,
} from '../ui/animations';

interface BaseModalProps {
    /** Controls modal visibility - triggers enter/exit animations */
    isOpen?: boolean;
    onClose: () => void;
    children: React.ReactNode;
    className?: string;
    showDragHandle?: boolean;
    showBackdrop?: boolean;
    zIndex?: number;
    animationConfig?: AnimationConfig;
    variant?: ModalVariant;
    /** Additional styles for the outer wrapper */
    style?: React.CSSProperties;
    /** Additional styles for the modal surface */
    contentStyle?: React.CSSProperties;
    /** Called when exit animation completes */
    onExitComplete?: () => void;
    /** Called when entry animation completes (modal is fully visible) */
    onAnimationComplete?: () => void;
    /** Disable swipe-to-dismiss gesture (default: false for bottom-sheet, true for centered) */
    disableSwipeToDismiss?: boolean;
    /** Reduce heavy visual effects for smoother animation on low-power devices */
    performanceMode?: 'standard' | 'reduced-effects';
}

// Swipe-to-dismiss threshold constants
const SWIPE_THRESHOLD_DISTANCE = 100; // px
const SWIPE_THRESHOLD_VELOCITY = 500; // px/s

/**
 * Base modal component with iOS-native animations
 * Supports both bottom-sheet (mobile) and centered (desktop) variants
 *
 * Animation system:
 * - Bottom-sheet: Spring physics matching UISheetPresentationController
 * - Centered: Scale from 1.05 with subtle overshoot (iOS Alert style)
 * - Backdrop: Faster fade for perceived performance
 * - Internal AnimatePresence handles exit animations
 * - Swipe-to-dismiss for bottom-sheet variant
 */
export const BaseModal: React.FC<BaseModalProps> = ({
    isOpen = true,
    onClose,
    children,
    className = '',
    showDragHandle = true,
    showBackdrop = true,
    zIndex = 60,
    animationConfig = { enabled: true },
    variant = 'bottom-sheet',
    style,
    contentStyle,
    onExitComplete,
    onAnimationComplete,
    disableSwipeToDismiss,
    performanceMode = 'standard',
}) => {
    const isAnimationEnabled = animationConfig.enabled && !prefersReducedMotion();
    const isBottomSheet = variant === 'bottom-sheet';
    // Always reduce effects (no backdrop blur) for consistent performance across all platforms
    const reduceEffects = true;

    // Detect dark mode for glass styling
    const isDark = typeof document !== 'undefined' &&
        document.body.classList.contains('theme-dark');

    // Swipe-to-dismiss is enabled by default for bottom-sheet, disabled for centered
    const swipeEnabled = disableSwipeToDismiss !== undefined
        ? !disableSwipeToDismiss
        : isBottomSheet;

    // Track drag state for backdrop opacity and GPU optimization
    const [isDragging, setIsDragging] = useState(false);
    const dragY = useMotionValue(0);

    // Transform drag position to backdrop opacity (fade out as modal drags down)
    const backdropOpacity = useTransform(dragY, [0, 300], [1, 0.3]);

    const backdropClass = "absolute inset-0 bg-black/50";

    // Different styling based on variant
    const containerClass = variant === 'centered'
        ? "flex items-center justify-center"
        : "flex flex-col justify-end";

    // Remove shadow/border classes - handled in modalStyle for glass effect
    const modalBaseClass = variant === 'centered'
        ? "rounded-2xl max-w-lg w-full mx-4"
        : "relative w-full rounded-t-3xl";

    // Glass surface styling - refined, minimal glassmorphism
    // GPU optimization: always set will-change on modal to prevent layer promotion/demotion during animation
    const modalStyle: React.CSSProperties = {
        // Glass surface
        backgroundColor: isDark
            ? 'rgba(28, 28, 30, 1)'
            : 'rgba(255, 255, 255, 1)',
        backdropFilter: reduceEffects ? 'none' : 'blur(20px)',
        WebkitBackdropFilter: reduceEffects ? 'none' : 'blur(20px)',
        // Refined border
        border: isDark
            ? '1px solid rgba(255, 255, 255, 0.06)'
            : '1px solid rgba(0, 0, 0, 0.04)',
        // Subtle shadow for depth
        boxShadow: isDark
            ? (reduceEffects
                ? '0 6px 16px rgba(0, 0, 0, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.04)'
                : '0 8px 32px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.04)')
            : (reduceEffects
                ? '0 6px 16px rgba(0, 0, 0, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.8)'
                : '0 8px 32px rgba(0, 0, 0, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.8)'),
        paddingBottom: variant === 'centered' ? '16px' : 'max(env(safe-area-inset-bottom), 16px)',
        color: 'var(--text-normal)',
        // Always promote to own layer for consistent GPU compositing
        willChange: 'transform, opacity',
    };

    // Refined drag handle - slightly larger, more visible
    const dragHandleStyle: React.CSSProperties = {
        backgroundColor: isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.08)',
        width: '40px',
        height: '5px',
        borderRadius: '9999px',
    };

    // iOS-native bottom-sheet animation (UISheetPresentationController-style)
    const bottomSheetVariants = isAnimationEnabled ? {
        hidden: { y: '100%' },
        visible: { y: 0 },
        exit: { y: '100%' }
    } : {
        hidden: {},
        visible: {},
        exit: {}
    };

    // iOS-native centered modal animation (scale from 1.05 for overshoot effect)
    const centeredVariants = isAnimationEnabled ? {
        hidden: { opacity: 0, scale: 1.05 },
        visible: { opacity: 1, scale: 1 },
        exit: { opacity: 0, scale: 0.95 }
    } : {
        hidden: {},
        visible: {},
        exit: {}
    };

    const modalVariants = variant === 'centered' ? centeredVariants : bottomSheetVariants;

    // iOS-native spring physics for entry, quick tween for exit
    const modalTransition = isAnimationEnabled
        ? (variant === 'centered' ? IOS_SPRING.alert : IOS_SPRING.bottomSheet)
        : { duration: 0 };

    // Handle swipe-to-dismiss gesture
    const handleDragStart = useCallback(() => {
        setIsDragging(true);
    }, []);

    const handleDragEnd = useCallback((_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
        setIsDragging(false);

        // Dismiss if dragged far enough or with enough velocity
        if (info.offset.y > SWIPE_THRESHOLD_DISTANCE || info.velocity.y > SWIPE_THRESHOLD_VELOCITY) {
            onClose();
        }
    }, [onClose]);

    // Handle animation completion - only fire callback for entry animation
    const handleAnimationComplete = useCallback((definition: string) => {
        if (definition === 'visible') {
            onAnimationComplete?.();
        }
    }, [onAnimationComplete]);

    // Drag constraints - only allow dragging down
    const dragConstraints = { top: 0, bottom: 0 };

    // Elastic resistance - no resistance at top, elastic at bottom
    const dragElastic = { top: 0, bottom: 0.4 };

    return (
        <AnimatePresence onExitComplete={onExitComplete}>
            {isOpen && (
                <motion.div
                    key="modal-container"
                    className={`fixed inset-0 ${containerClass}`}
                    style={{
                        zIndex,
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        ...style
                    }}
                    // Handle taps outside modal content to close
                    onTouchStart={onClose}
                    onClick={onClose}
                >
                    {/* Backdrop - faster animation for perceived performance */}
                    {showBackdrop && (
                        <motion.div
                            key="backdrop"
                            initial={isAnimationEnabled ? { opacity: 0 } : { opacity: 1 }}
                            animate={{ opacity: 1 }}
                            exit={isAnimationEnabled ? { opacity: 0 } : { opacity: 1 }}
                            transition={isAnimationEnabled ? BACKDROP_ANIMATION.enter : { duration: 0 }}
                            className={backdropClass}
                            style={swipeEnabled && isDragging ? { opacity: backdropOpacity } : undefined}
                        />
                    )}

                    {/* Modal Content - iOS-native spring animation with swipe-to-dismiss */}
                    <motion.div
                        key="modal"
                        initial="hidden"
                        animate="visible"
                        exit="exit"
                        onAnimationComplete={handleAnimationComplete}
                        variants={{
                            hidden: modalVariants.hidden,
                            visible: {
                                ...modalVariants.visible,
                                transition: modalTransition
                            },
                            exit: {
                                ...modalVariants.exit,
                                transition: isAnimationEnabled
                                    ? (variant === 'centered' ? IOS_EXIT.alert : IOS_EXIT.bottomSheet)
                                    : { duration: 0 }
                            }
                        }}
                        // Swipe-to-dismiss configuration (bottom-sheet only by default)
                        drag={swipeEnabled ? "y" : false}
                        dragConstraints={dragConstraints}
                        dragElastic={dragElastic}
                        dragMomentum={false}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                        style={{
                            ...modalStyle,
                            ...contentStyle,
                            y: swipeEnabled ? dragY : undefined
                        }}
                        className={`${modalBaseClass} ${className}`}
                        // Prevent taps on content from closing the modal
                        onTouchStart={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Drag Handle - only for bottom-sheet, serves as visual affordance for swipe */}
                        {showDragHandle && variant === 'bottom-sheet' && (
                            <div
                                className="flex justify-center pt-3 pb-1"
                                style={{ touchAction: 'none' }} // Improve drag gesture
                            >
                                <div style={dragHandleStyle} />
                            </div>
                        )}

                        {/* Content */}
                        {children}
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};
