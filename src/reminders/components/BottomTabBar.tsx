import React, { memo } from 'react';
import { NavigationBar } from '../../ui/shared/NavigationBar';
import { TABS, type TabId } from '../ui/layoutConstants';

const items = TABS.map(tab => ({ ...tab, dataTab: tab.id === 'browse' ? 'projects' : tab.id }));

/** Reminder destinations use the same navigation as Reading. */
export const BottomTabBar = memo(function BottomTabBar(props: {
  inert?: boolean;
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  position?: 'top' | 'bottom';
  className?: string;
  animateActiveIndicator?: boolean;
}) {
  return <NavigationBar {...props} items={items} label="Reminder views" />;
});
