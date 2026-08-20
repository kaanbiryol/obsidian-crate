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

  return (
    <motion.button
      ref={buttonRef}
      className={`bottom-tab-button${isActive ? ' is-active' : ''}`}
      whileTap={{ scale: 0.95 }}
      transition={{ duration: 0.1 }}
      data-action="switch-tab"
      data-tab={tab.id === 'browse' ? 'projects' : tab.id}
    >
      {/* Active indicator with layoutId for smooth sliding */}
      {isActive && (
        <motion.div
          layoutId={layoutId}
          className="bottom-tab-indicator"
          transition={{ type: 'spring', ...SPRING_CONFIG }}
        />
      )}

      <div className="bottom-tab-content">
        <div className="bottom-tab-icon">
          <Icon
            size={24}
            strokeWidth={isActive ? 2.5 : 2}
          />
        </div>
        <span className="bottom-tab-label">
          {tab.label}
        </span>
      </div>
    </motion.button>
  );
});

interface BottomTabBarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  position?: 'top' | 'bottom';
  className?: string;
}

/**
 * Shared bottom tab bar component for navigation.
 */
export const BottomTabBar = memo(function BottomTabBar({
  activeTab,
  onTabChange,
  position = 'bottom',
  className = '',
}: BottomTabBarProps) {
  const layoutId = position === 'top' ? 'topActiveTabIndicator' : 'bottomActiveTabIndicator';

  return (
    <div
      className={`bottom-tab-bar${position === 'bottom' ? ' is-bottom' : ''} ${className}`}
    >
      <div className="bottom-tab-items">
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
