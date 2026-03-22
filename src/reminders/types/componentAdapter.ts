/**
 * Component Adapter Types
 *
 * Shared UI configuration types used by the Obsidian plugin UI.
 */

/**
 * Animation configuration for components
 * Controls whether and how components animate
 */
export interface AnimationConfig {
  /** Whether animations are enabled */
  enabled: boolean;
  /** Animation duration in seconds (default: 0.3) */
  duration?: number;
  /** Stagger delay between items in milliseconds (default: 30) */
  stagger?: number;
}

/**
 * Modal variant types
 * - bottom-sheet: Slides up from bottom (mobile-friendly)
 * - centered: Centered modal (desktop-friendly)
 */
export type ModalVariant = 'bottom-sheet' | 'centered';
