import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, Trash2, X } from 'lucide-react';
import type { AnimationConfig } from '../types/componentAdapter';
import { IOS_SPRING, IOS_EXIT, BACKDROP_ANIMATION, prefersReducedMotion } from '../ui/animations';
import { ShadowDOMButton, ShadowDOMNativeButton } from './ShadowDOMButton';

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
 * A refined delete confirmation modal that replaces native confirm() dialogs
 * Features smooth animations, clear visual hierarchy, and a premium feel
 */
export const DeleteConfirmationModal: React.FC<DeleteConfirmationModalProps> = ({
    isOpen,
    onClose,
    onConfirm,
    title = 'Delete Reminder',
    message = 'This action cannot be undone. Are you sure you want to delete this reminder?',
    confirmLabel = 'Delete',
    cancelLabel = 'Cancel',
    animationConfig = { enabled: true },
    isLoading = false
}) => {
    const handleConfirm = () => {
        onConfirm();
    };

    const styles = {
        backdrop: 'bg-black/60 backdrop-blur-sm',
        container: 'bg-[var(--background-primary)] border-[var(--background-modifier-border)]',
        title: 'text-[var(--text-normal)]',
        message: 'text-[var(--text-muted)]',
        iconBg: 'bg-[var(--background-modifier-error)]/10',
        iconColor: 'text-[var(--text-error)]'
    };
    const isAnimationEnabled = animationConfig.enabled && !prefersReducedMotion();

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

    const iconVariants = isAnimationEnabled ? {
        hidden: { scale: 0.5, opacity: 0 },
        visible: {
            scale: 1,
            opacity: 1,
            transition: {
                delay: 0.1,
                ...IOS_SPRING.quick
            }
        }
    } : {
        hidden: { scale: 1, opacity: 1 },
        visible: { scale: 1, opacity: 1 }
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
        <AnimatePresence>
            {isOpen && (
                <div
                    className="fixed inset-0 z-[100] flex items-center justify-center p-4"
                    style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0 }}
                >
                    {/* Backdrop - faster animation for perceived performance */}
                    <motion.div
                        key="delete-backdrop"
                        variants={backdropVariants}
                        initial="hidden"
                        animate="visible"
                        exit="exit"
                        transition={isAnimationEnabled ? BACKDROP_ANIMATION.enter : { duration: 0 }}
                        className={`absolute inset-0 ${styles.backdrop}`}
                        onClick={onClose}
                    />

                    {/* Modal */}
                    <motion.div
                        key="delete-modal"
                        variants={modalVariants}
                        initial="hidden"
                        animate="visible"
                        exit="exit"
                        className={`
                            relative w-full max-w-[320px] rounded-2xl border shadow-xl py-4
                            ${styles.container}
                        `}
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Close button - 44pt touch target per Apple HIG */}
                        <ShadowDOMNativeButton
                            onClick={onClose}
                            className="absolute top-2 right-2 w-11 h-11 flex items-center justify-center rounded-full text-default-400 hover:text-default-600 hover:bg-default-100 transition-colors z-10"
                            style={{
                                background: 'transparent',
                                border: 'none',
                                cursor: 'pointer',
                                padding: 0,
                            }}
                        >
                            <X size={20} />
                        </ShadowDOMNativeButton>

                        <div className="px-6 pb-4">
                            {/* Icon */}
                            <motion.div
                                variants={iconVariants}
                                initial="hidden"
                                animate="visible"
                                className="flex justify-center mb-3"
                            >
                                <div className={`
                                    w-12 h-12 rounded-xl flex items-center justify-center
                                    ${styles.iconBg}
                                `}>
                                    <AlertTriangle
                                        size={24}
                                        strokeWidth={2}
                                        className={styles.iconColor}
                                    />
                                </div>
                            </motion.div>

                            {/* Title */}
                            <motion.h3
                                custom={0}
                                variants={contentVariants}
                                initial="hidden"
                                animate="visible"
                                className={`text-center text-lg font-semibold mb-2 ${styles.title}`}
                            >
                                {title}
                            </motion.h3>

                            {/* Message */}
                            <motion.p
                                custom={1}
                                variants={contentVariants}
                                initial="hidden"
                                animate="visible"
                                className={`text-center text-base leading-relaxed ${styles.message}`}
                            >
                                {message}
                            </motion.p>
                        </div>

                        {/* Actions - 48pt button height per Apple HIG */}
                        <motion.div
                            custom={2}
                            variants={contentVariants}
                            initial="hidden"
                            animate="visible"
                            className="px-6 flex gap-3"
                        >
                            <ShadowDOMButton
                                size="lg"
                                variant="flat"
                                onPress={onClose}
                                className="flex-1 font-medium text-base h-12 bg-default-100 hover:bg-default-200"
                                isDisabled={isLoading}
                            >
                                {cancelLabel}
                            </ShadowDOMButton>
                            <ShadowDOMButton
                                size="lg"
                                color="danger"
                                onPress={handleConfirm}
                                className="flex-1 font-medium text-base h-12"
                                isLoading={isLoading}
                                startContent={!isLoading && <Trash2 size={18} />}
                            >
                                {confirmLabel}
                            </ShadowDOMButton>
                        </motion.div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};
