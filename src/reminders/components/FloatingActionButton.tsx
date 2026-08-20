import React, { memo } from 'react';
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
  return (
    <ShadowDOMNativeMotionButton
      onClick={onClick}
      className={`reminders-fab ${className}`}
      initial={{ scale: 0, rotate: -180 }}
      animate={{ scale: 1, rotate: 0 }}
      exit={{ scale: 0, rotate: 180 }}
      transition={{ type: 'spring', stiffness: 300, damping: 20 }}
      whileTap={{ scale: 0.85, rotate: 90 }}
      whileHover={{ scale: 1.1 }}
      aria-label={ariaLabel}
      data-action={dataAction}
    >
      {icon || <Plus size={24} strokeWidth={2.5} />}
    </ShadowDOMNativeMotionButton>
  );
});
