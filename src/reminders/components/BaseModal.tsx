import React, { useCallback, useState } from 'react';
import { motion, AnimatePresence, MotionConfig, PanInfo, useMotionValue, useTransform } from 'framer-motion';
import type { AnimationConfig, ModalVariant } from '../types/componentAdapter';
import {
    IOS_SPRING,
    IOS_EXIT,
    BACKDROP_ANIMATION,
} from '../ui/animations';
import { useObsidianReducedMotion } from '../ui/useObsidianReducedMotion';

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
    /** Accessible name for the dialog surface. */
    ariaLabel?: string;
    /** ID of an element that labels the dialog surface. */
    ariaLabelledBy?: string;
    ariaDescribedBy?: string;
    role?: 'dialog' | 'alertdialog';
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
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
    ariaLabel,
    ariaLabelledBy,
    ariaDescribedBy,
    role = 'dialog',
    onKeyDown,
}) => {
    const isAnimationEnabled = animationConfig.enabled && !useObsidianReducedMotion();
    const isBottomSheet = variant === 'bottom-sheet';

    // Swipe-to-dismiss is enabled by default for bottom-sheet, disabled for centered
    const swipeEnabled = disableSwipeToDismiss !== undefined
        ? !disableSwipeToDismiss
        : isBottomSheet;

    // Track drag state for backdrop opacity and GPU optimization
    const [isDragging, setIsDragging] = useState(false);
    const dragY = useMotionValue(0);

    // Transform drag position to backdrop opacity (fade out as modal drags down)
    const backdropOpacity = useTransform(dragY, [0, 300], [1, 0.3]);

    const backdropClass = "modal-backdrop absolute inset-0";

    // Different styling based on variant
    const containerClass = variant === 'centered'
        ? "flex items-center justify-center"
        : "flex flex-col justify-end";

    // Remove shadow/border classes - handled in modalStyle for glass effect
    const modalBaseClass = variant === 'centered'
        ? "base-modal-surface is-centered max-w-lg w-full mx-4"
        : "base-modal-surface is-bottom-sheet relative w-full";

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
      <MotionConfig reducedMotion={isAnimationEnabled ? 'user' : 'always'}>
        <AnimatePresence onExitComplete={onExitComplete}>
            {isOpen && (
                <motion.div
                    key="modal-container"
                    className={`base-modal-container fixed inset-0 ${containerClass}`}
                    style={{
                        zIndex,
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
                            ...contentStyle,
                            y: swipeEnabled ? dragY : undefined
                        }}
                        className={`${modalBaseClass} ${className}`}
                        role={role}
                        aria-modal="true"
                        aria-label={ariaLabelledBy ? undefined : ariaLabel}
                        aria-labelledby={ariaLabelledBy}
                        aria-describedby={ariaDescribedBy}
                        onKeyDown={onKeyDown}
                        tabIndex={-1}
                        // Prevent taps on content from closing the modal
                        onTouchStart={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Drag Handle - only for bottom-sheet, serves as visual affordance for swipe */}
                        {showDragHandle && variant === 'bottom-sheet' && (
                            <div
                                className="base-modal-drag-region flex justify-center pt-3 pb-1"
                            >
                                <div className="base-modal-drag-handle" />
                            </div>
                        )}

                        {/* Content */}
                        {children}
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
      </MotionConfig>
    );
};
