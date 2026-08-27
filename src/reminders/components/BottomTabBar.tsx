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
}

/**
 * Individual tab button component
 * Uses native button with capture-phase click for Shadow DOM compatibility
 */
const TabButton = memo(function TabButton({
  tab,
  isActive,
  onTabChange,
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
    <button
      ref={buttonRef}
      className={`bottom-tab-button${isActive ? ' is-active' : ''}`}
      data-action="switch-tab"
      data-tab={tab.id === 'browse' ? 'projects' : tab.id}
    >
      <div className="bottom-tab-content">
        <div className="bottom-tab-icon">
          <Icon
            size={24}
            strokeWidth={2}
          />
        </div>
        <span className="bottom-tab-label">
          {tab.label}
        </span>
      </div>
    </button>
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
  const activeIndex = Math.max(0, TABS.findIndex((tab) => tab.id === activeTab));

  return (
    <div
      className={`bottom-tab-bar${position === 'bottom' ? ' is-bottom' : ''} ${className}`}
    >
      <div className="bottom-tab-items">
        <div className="bottom-tab-slider-track" aria-hidden="true">
          <motion.div
            layout
            initial={false}
            className="bottom-tab-slider"
            style={{ gridColumn: activeIndex + 1 }}
            transition={{ type: 'spring', ...SPRING_CONFIG }}
          />
        </div>
        {TABS.map((tab) => (
          <TabButton
            key={tab.id}
            tab={tab}
            isActive={activeTab === tab.id}
            onTabChange={onTabChange}
          />
        ))}
      </div>
    </div>
  );
});
