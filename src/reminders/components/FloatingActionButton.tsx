import React, { memo } from 'react';
import { Plus } from 'lucide-react';
import { FAB_SIZE } from '../ui/layoutConstants';
import { ShadowDOMNativeMotionButton } from './ShadowDOMButton';

interface FloatingActionButtonProps {
  onClick: () => void;
  className?: string;
  style?: React.CSSProperties;
  icon?: React.ReactNode;
  'aria-label'?: string;
}

/**
 * Shared Floating Action Button component
 * Provides consistent FAB styling and animations for the Obsidian plugin UI.
 */
export const FloatingActionButton = memo(function FloatingActionButton({
  onClick,
  className = '',
  style = {},
  icon,
  'aria-label': ariaLabel = 'Add reminder'
}: FloatingActionButtonProps) {
  const backgroundColor = '#7c3aed';
  const shadowColor = 'rgba(124, 58, 237, 0.4)';

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
      style={{
        width: FAB_SIZE,
        height: FAB_SIZE,
        borderRadius: '50%',
        background: backgroundColor,
        color: 'white',
        border: 'none',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: `0 4px 12px ${shadowColor}`,
        zIndex: 50,
        ...style
      }}
    >
      {icon || <Plus size={24} strokeWidth={2.5} />}
    </ShadowDOMNativeMotionButton>
  );
});
