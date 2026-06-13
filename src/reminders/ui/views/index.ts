/**
 * Shared View Components
 *
 * These components provide the main view layouts for the plugin.
 * They handle the display of reminders with consistent styling and animations.
 *
 * Usage:
 * - Import directly: import { InboxView } from '@/reminders/ui/views';
 *
 * Each view accepts:
 * - reminders: Array of reminder objects
 * - renderCard: Optional custom card renderer for platform-specific wrappers
 */

export { InboxView } from './InboxView';
export { TodayView } from './TodayView';
export { UpcomingView } from './UpcomingView';
export { BrowseView } from './BrowseView';
export { ProjectDetailView } from './ProjectDetailView';
