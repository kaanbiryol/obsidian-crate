import React from 'react';
import { motion } from 'motion/react';
import { SPRING_CONFIG } from '../../reminders/ui/layoutConstants';
import { useObsidianReducedMotion } from '../../reminders/ui/useObsidianReducedMotion';
import { ThemeIcon } from '../../reminders/components/theme-icon';
import { Button } from './Button';

export interface NavigationItem<T extends string> {
  id: T;
  label: string;
  iconName: string;
  dataTab?: string;
}

/** Shared navigation geometry, active indicator, and Base UI controls. */
export function NavigationBar<T extends string>({ items, activeTab, onTabChange, label, position = 'bottom', className = '', animateActiveIndicator = true, inert = false, action = 'switch-tab' }: {
  items: readonly NavigationItem<T>[];
  activeTab: T;
  onTabChange: (tab: T) => void;
  label: string;
  position?: 'top' | 'bottom';
  className?: string;
  animateActiveIndicator?: boolean;
  inert?: boolean;
  action?: string;
}) {
  const reduceMotion = useObsidianReducedMotion();
  const activeIndex = Math.max(0, items.findIndex(tab => tab.id === activeTab));
  const indicatorStyle = { gridColumn: activeIndex + 1 };
  return <nav inert={inert} className={`bottom-tab-bar${position === 'bottom' ? ' is-bottom' : ''} ${className}`} aria-label={label}>
    <div className="bottom-tab-items">
      <div className="bottom-tab-slider-track" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }} aria-hidden="true">
        {animateActiveIndicator && !reduceMotion
          ? <motion.div layout initial={false} className="bottom-tab-slider" style={indicatorStyle} transition={{ type: 'spring', ...SPRING_CONFIG }} />
          : <div className="bottom-tab-slider" style={indicatorStyle} />}
      </div>
      {items.map(tab => <Button key={tab.id} onClick={() => onTabChange(tab.id)} className={`bottom-tab-button${activeTab === tab.id ? ' is-active' : ''}`} data-action={action} data-tab={tab.dataTab ?? tab.id} aria-current={activeTab === tab.id ? 'page' : undefined}>
        <div className="bottom-tab-content"><div className="bottom-tab-icon"><ThemeIcon size="l" id={tab.iconName} aria-hidden="true" /></div><span className="bottom-tab-label">{tab.label}</span></div>
      </Button>)}
    </div>
  </nav>;
}
