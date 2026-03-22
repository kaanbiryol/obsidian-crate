/**
 * Layout spacing constants for consistent UI measurements
 * These values are shared across the plugin UI for visual consistency
 */

// ============================================
// Content padding (consistent across all views)
// ============================================
export const CONTENT_PADDING_X = 16; // Horizontal padding (1rem = 16px)
export const CONTENT_PADDING_TOP = 16; // Top padding (matches horizontal spacing)

// ============================================
// Floating Action Button (FAB)
// ============================================
export const FAB_SIZE = 56; // w-14 h-14 = 56px
const FAB_GAP = 24; // Gap between FAB and bottom nav (matches tab bar spacing)

// ============================================
// Scroll padding for views
// ============================================

// With FAB (Inbox, Today, Upcoming views) - need to clear both bottom nav and FAB
export const SCROLL_PADDING_WITH_FAB_CSS = `calc(var(--reminders-tabbar-overlay, 0px) + var(--reminders-fab-gap, ${FAB_GAP}px) + var(--reminders-fab-size, ${FAB_SIZE}px) + var(--reminders-safe-area, env(safe-area-inset-bottom)))`;

// Without FAB (Browse view) - just need to clear bottom nav
export const SCROLL_PADDING_WITHOUT_FAB_CSS = `calc(var(--reminders-tabbar-overlay, 0px) + var(--reminders-bottom-gap, 16px) + var(--reminders-safe-area, env(safe-area-inset-bottom)))`;

// ============================================
// Animation constants
// ============================================

// Unified easing curve (expo-out: fast start, gentle settle)
export const EASE_EXPO_OUT = [0.16, 1, 0.3, 1] as const;

// Material Design standard easing (used for exits)
export const EASE_STANDARD = [0.4, 0, 0.2, 1] as const;

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
  iconName: 'Inbox' | 'Calendar' | 'CalendarRange' | 'FolderOpen';
}

export const TABS: TabDefinition[] = [
  { id: 'inbox', label: 'Inbox', iconName: 'Inbox' },
  { id: 'today', label: 'Today', iconName: 'Calendar' },
  { id: 'upcoming', label: 'Upcoming', iconName: 'CalendarRange' },
  { id: 'browse', label: 'Projects', iconName: 'FolderOpen' },
];
