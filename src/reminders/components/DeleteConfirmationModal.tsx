import React from 'react';
import { motion, AnimatePresence, MotionConfig } from 'framer-motion';
import type { AnimationConfig } from '../types/componentAdapter';
import { IOS_SPRING, IOS_EXIT, BACKDROP_ANIMATION } from '../ui/animations';
import { useObsidianReducedMotion } from '../ui/useObsidianReducedMotion';
import { ShadowDOMButton } from './ShadowDOMButton';

interface DeleteConfirmationModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title?: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    animationConfig?: AnimationConfig;
    isLoading?: boolean;
}

/**
 * Theme-aware delete confirmation used in the reminders shadow root.
 */
export const DeleteConfirmationModal: React.FC<DeleteConfirmationModalProps> = ({
    isOpen,
    onClose,
    onConfirm,
    title = 'Delete reminder?',
    message = "Delete this reminder? This can't be undone.",
    confirmLabel = 'Delete',
    cancelLabel = 'Cancel',
    animationConfig = { enabled: true },
    isLoading = false
}) => {
    const handleConfirm = () => {
        onConfirm();
    };

    const isAnimationEnabled = animationConfig.enabled && !useObsidianReducedMotion();

    const backdropVariants = isAnimationEnabled ? {
        hidden: { opacity: 0 },
        visible: { opacity: 1 },
        exit: { opacity: 0 }
    } : {
        hidden: { opacity: 1 },
        visible: { opacity: 1 },
        exit: { opacity: 1 }
    };

    // iOS-native alert animation (scale from 1.05 for overshoot effect)
    const modalVariants = isAnimationEnabled ? {
        hidden: {
            opacity: 0,
            scale: 1.05
        },
        visible: {
            opacity: 1,
            scale: 1,
            transition: IOS_SPRING.alert
        },
        exit: {
            opacity: 0,
            scale: 0.95,
            transition: IOS_EXIT.alert
        }
    } : {
        hidden: {},
        visible: {},
        exit: {}
    };

    const contentVariants = isAnimationEnabled ? {
        hidden: { opacity: 0, y: 8 },
        visible: (i: number) => ({
            opacity: 1,
            y: 0,
            transition: {
                delay: 0.12 + i * 0.05,
                duration: 0.2,
                ease: [0.25, 0.46, 0.45, 0.94] as [number, number, number, number]
            }
        })
    } : {
        hidden: { opacity: 1, y: 0 },
        visible: { opacity: 1, y: 0 }
    };

    return (
      <MotionConfig reducedMotion={isAnimationEnabled ? 'user' : 'always'}>
        <AnimatePresence>
            {isOpen && (
                <div
                    className="fixed inset-0 z-[100] flex items-center justify-center p-4"
                >
                    {/* Backdrop - faster animation for perceived performance */}
                    <motion.div
                        key="delete-backdrop"
                        variants={backdropVariants}
                        initial="hidden"
                        animate="visible"
                        exit="exit"
                        transition={isAnimationEnabled ? BACKDROP_ANIMATION.enter : { duration: 0 }}
                        className="modal-backdrop is-interactive absolute inset-0"
                        onClick={onClose}
                    />

                    {/* Modal */}
                    <motion.div
                        key="delete-modal"
                        variants={modalVariants}
                        initial="hidden"
                        animate="visible"
                        exit="exit"
                        className="delete-confirmation-surface relative w-full"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="delete-confirmation-copy">
                            {/* Title */}
                            <motion.h3
                                custom={0}
                                variants={contentVariants}
                                initial="hidden"
                                animate="visible"
                                className="delete-confirmation-title"
                            >
                                {title}
                            </motion.h3>

                            {/* Message */}
                            <motion.p
                                custom={1}
                                variants={contentVariants}
                                initial="hidden"
                                animate="visible"
                                className="delete-confirmation-message"
                            >
                                {message}
                            </motion.p>
                        </div>

                        {/* Compact, explicit actions */}
                        <motion.div
                            custom={2}
                            variants={contentVariants}
                            initial="hidden"
                            animate="visible"
                            className="delete-confirmation-actions"
                        >
                            <ShadowDOMButton
                                size="lg"
                                variant="flat"
                                onPress={onClose}
                                className="delete-confirmation-button delete-confirmation-cancel"
                                isDisabled={isLoading}
                            >
                                {cancelLabel}
                            </ShadowDOMButton>
                            <ShadowDOMButton
                                size="lg"
                                color="danger"
                                onPress={handleConfirm}
                                className="delete-confirmation-button delete-confirmation-confirm"
                                isLoading={isLoading}
                            >
                                {confirmLabel}
                            </ShadowDOMButton>
                        </motion.div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
      </MotionConfig>
    );
};
