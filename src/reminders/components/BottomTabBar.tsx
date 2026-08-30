import React, { memo } from 'react';
import { motion } from 'framer-motion';
import { Inbox, Calendar, CalendarRange, FolderOpen } from 'lucide-react';
import { TABS, SPRING_CONFIG, type TabId } from '../ui/layoutConstants';
import { ShadowDOMNativeButton } from './ShadowDOMNativeButton';

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
 * Uses the shared capture-phase click bridge for Shadow DOM compatibility.
 */
const TabButton = memo(function TabButton({
  tab,
  isActive,
  onTabChange,
}: TabButtonProps) {
  const Icon = IconMap[tab.iconName];

  return (
    <ShadowDOMNativeButton
      onClick={() => onTabChange(tab.id)}
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
    </ShadowDOMNativeButton>
  );
});

interface BottomTabBarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  position?: 'top' | 'bottom';
  className?: string;
  animateActiveIndicator?: boolean;
}

/**
 * Shared bottom tab bar component for navigation.
 */
export const BottomTabBar = memo(function BottomTabBar({
  activeTab,
  onTabChange,
  position = 'bottom',
  className = '',
  animateActiveIndicator = true,
}: BottomTabBarProps) {
  const activeIndex = Math.max(0, TABS.findIndex((tab) => tab.id === activeTab));

  return (
    <div
      className={`bottom-tab-bar${position === 'bottom' ? ' is-bottom' : ''} ${className}`}
    >
      <div className="bottom-tab-items">
        <div className="bottom-tab-slider-track" aria-hidden="true">
          {animateActiveIndicator ? (
            <motion.div
              layout
              initial={false}
              className="bottom-tab-slider"
              style={{ gridColumn: activeIndex + 1 }}
              transition={{ type: 'spring', ...SPRING_CONFIG }}
            />
          ) : (
            <div
              className="bottom-tab-slider"
              style={{ gridColumn: activeIndex + 1 }}
            />
          )}
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
