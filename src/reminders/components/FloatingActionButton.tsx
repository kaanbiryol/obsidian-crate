import React, { memo } from 'react';
import { useReducedMotion } from 'framer-motion';
import { Plus } from 'lucide-react';
import { ShadowDOMNativeMotionButton } from './ShadowDOMButton';

interface FloatingActionButtonProps {
  onClick: () => void;
  className?: string;
  icon?: React.ReactNode;
  'aria-label'?: string;
  'data-action'?: string;
}

/**
 * Shared Floating Action Button component
 * Provides consistent FAB styling and animations for the Obsidian plugin UI.
 */
export const FloatingActionButton = memo(function FloatingActionButton({
  onClick,
  className = '',
  icon,
  'aria-label': ariaLabel = 'Add reminder',
  'data-action': dataAction,
}: FloatingActionButtonProps) {
  const prefersReducedMotion = useReducedMotion();

  return (
    <ShadowDOMNativeMotionButton
      onClick={onClick}
      className={`reminders-fab ${className}`}
      initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
      transition={prefersReducedMotion
        ? { duration: 0 }
        : { type: 'spring', stiffness: 420, damping: 30 }}
      whileTap={prefersReducedMotion ? undefined : { scale: 0.94 }}
      whileHover={prefersReducedMotion ? undefined : { scale: 1.04 }}
      aria-label={ariaLabel}
      data-action={dataAction}
    >
      {icon || <Plus size={24} strokeWidth={2.5} />}
    </ShadowDOMNativeMotionButton>
  );
});
