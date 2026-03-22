import React, { memo, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Inbox, Calendar, CalendarRange, FolderOpen } from 'lucide-react';
import { TABS, SPRING_CONFIG, type TabId } from '../ui/layoutConstants';

// Icon component map
const IconMap = {
  Inbox,
  Calendar,
  CalendarRange,
  FolderOpen,
} as const;

interface TabButtonProps {
  tab: typeof TABS[number];
  isActive: boolean;
  onTabChange: (id: TabId) => void;
  layoutId: string;
}

/**
 * Individual tab button component
 * Uses native button with capture-phase click for Shadow DOM compatibility
 */
const TabButton = memo(function TabButton({
  tab,
  isActive,
  onTabChange,
  layoutId
}: TabButtonProps) {
  const Icon = IconMap[tab.iconName];
  const buttonRef = useRef<HTMLButtonElement>(null);

  const activeColor = '#7c3aed';
  const inactiveColor = 'var(--text-faint)';

  // Use capture-phase click handler for Shadow DOM
  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return;

    const handleClick = (e: MouseEvent) => {
      e.stopPropagation();
      onTabChange(tab.id);
    };

    button.addEventListener('click', handleClick, true);
    return () => button.removeEventListener('click', handleClick, true);
  }, [onTabChange, tab.id]);

  // Inline styles for Shadow DOM compatibility
  const buttonStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    padding: '10px 16px',
    position: 'relative',
    minHeight: '48px',
    minWidth: 0,
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    outline: 'none',
    WebkitAppearance: 'none',
    appearance: 'none',
  };

  return (
    <motion.button
      ref={buttonRef}
      style={buttonStyle}
      whileTap={{ scale: 0.95 }}
      transition={{ duration: 0.1 }}
    >
      {/* Active indicator with layoutId for smooth sliding */}
      {isActive && (
        <motion.div
          layoutId={layoutId}
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '12px',
            background: 'rgba(124, 58, 237, 0.1)',
          }}
          transition={{ type: 'spring', ...SPRING_CONFIG }}
        />
      )}

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '4px',
        position: 'relative',
        zIndex: 10,
      }}>
        <motion.div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          animate={{ color: isActive ? activeColor : inactiveColor }}
          transition={{ duration: 0.15 }}
        >
          <Icon
            size={24}
            strokeWidth={isActive ? 2.5 : 2}
          />
        </motion.div>
        <motion.span
          animate={{ color: isActive ? activeColor : inactiveColor }}
          transition={{ duration: 0.15 }}
          style={{
            fontSize: '13px',
            fontWeight: isActive ? 600 : 500,
            letterSpacing: '0.01em',
            whiteSpace: 'nowrap',
          }}
        >
          {tab.label}
        </motion.span>
      </div>
    </motion.button>
  );
});

interface BottomTabBarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  position?: 'top' | 'bottom';
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Shared bottom tab bar component for navigation.
 */
export const BottomTabBar = memo(function BottomTabBar({
  activeTab,
  onTabChange,
  position = 'bottom',
  className = '',
  style = {}
}: BottomTabBarProps) {
  const layoutId = position === 'top' ? 'topActiveTabIndicator' : 'bottomActiveTabIndicator';

  // Base styles
  const containerStyle: React.CSSProperties = {
    flexShrink: 0,
    zIndex: 40,
    background: 'var(--background-primary)',
    borderTop: position === 'bottom'
      ? '1px solid var(--background-modifier-border)'
      : 'none',
    ...style
  };

  return (
    <div
      className={`bottom-tab-bar ${className}`}
      style={containerStyle}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-around',
          maxWidth: '42rem',
          margin: '0 auto',
          padding: '8px 12px',
        }}
      >
        {TABS.map((tab) => (
          <TabButton
            key={tab.id}
            tab={tab}
            isActive={activeTab === tab.id}
            onTabChange={onTabChange}
            layoutId={layoutId}
          />
        ))}
      </div>
    </div>
  );
});
