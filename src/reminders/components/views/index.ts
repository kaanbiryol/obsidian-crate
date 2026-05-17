/**
 * Shared View Components
 *
 * These components provide the main view layouts for the plugin.
 * They handle the display of reminders with consistent styling and animations.
 *
 * Usage:
 * - Import directly: import { InboxView } from '@obsidian-reminders/shared/components/views';
 * - Or via local barrel: import { InboxView } from '@/reminders/components/views';
 *
 * Each view accepts:
 * - reminders: Array of reminder objects
 * - renderCard: Optional custom card renderer for platform-specific wrappers
 */

export { InboxView, type InboxViewProps } from './InboxView';
export { TodayView, type TodayViewProps } from './TodayView';
export { UpcomingView, type UpcomingViewProps } from './UpcomingView';
export { BrowseView, type BrowseViewProps, type ProjectStats } from './BrowseView';
export { ProjectDetailView, type ProjectDetailViewProps } from './ProjectDetailView';
