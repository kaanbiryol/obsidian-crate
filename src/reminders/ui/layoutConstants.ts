import type { Easing } from 'framer-motion';

/**
 * Layout spacing constants for consistent UI measurements
 * These values are shared across the plugin UI for visual consistency
 */

// ============================================
// Animation constants
// ============================================

// Unified easing curve (expo-out: fast start, gentle settle)
export const EASE_EXPO_OUT: Easing = [0.16, 1, 0.3, 1];

// Material Design standard easing (used for exits)
export const EASE_STANDARD: Easing = [0.4, 0, 0.2, 1];

// Unified duration for content transitions
export const CONTENT_TRANSITION_DURATION = 0.35;

// Page-level transition duration (slightly faster)
export const PAGE_TRANSITION_DURATION = 0.18;

export const SPRING_CONFIG = {
  stiffness: 500,
  damping: 35,
  mass: 0.8
} as const;

// Slightly bouncier spring for expand/collapse transitions
export const SPRING_CONFIG_BOUNCY = {
  stiffness: 500,
  damping: 28,
  mass: 0.8
} as const;

// Position belongs to the row; the separate drag surface owns the subtle lift.
export const REMINDER_LIST_LAYOUT_TRANSITION = {
  type: 'spring' as const,
  stiffness: 500,
  damping: 44,
  mass: 0.8,
  restDelta: 0.5,
  restSpeed: 10,
} as const;

export const REMINDER_LIST_FADE_TRANSITION = { duration: 0.12, ease: 'easeOut' } as const;
export const REMINDER_SECTION_TRANSITION = { duration: 0.2, ease: EASE_STANDARD } as const;
export const REMINDER_DRAG_SCALE = 1.02;

// Default card enter/exit animation
export const CARD_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { type: 'spring', ...SPRING_CONFIG }
  },
  exit: {
    opacity: 0,
    y: -6,
    transition: { duration: 0.15, ease: 'easeOut' }
  }
} as const;

// Staggered card animation for lists (delays each item by index)
export const STAGGERED_CARD_ANIMATION = {
  initial: { opacity: 0, y: 12 },
  animate: (index: number) => ({
    opacity: 1,
    y: 0,
    transition: {
      type: 'spring' as const,
      ...SPRING_CONFIG,
      delay: index * 0.05, // 50ms stagger between items
    }
  }),
  exit: {
    opacity: 0,
    y: -6,
    transition: { duration: 0.15, ease: 'easeOut' as const }
  }
};

// ============================================
// Tab definitions
// ============================================
export type TabId = 'inbox' | 'today' | 'upcoming' | 'browse';

interface TabDefinition {
  id: TabId;
  label: string;
  iconName: string;
}

export const TABS: TabDefinition[] = [
  { id: 'inbox', label: 'Inbox', iconName: 'inbox' },
  { id: 'today', label: 'Today', iconName: 'calendar' },
  { id: 'upcoming', label: 'Upcoming', iconName: 'calendar-range' },
  { id: 'browse', label: 'Projects', iconName: 'folder-open' },
];
