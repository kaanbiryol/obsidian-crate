import { LoadingIndicator } from '@/ui/shared/LoadingIndicator';
import { useObsidianReducedMotion } from './useObsidianReducedMotion';
import './reminders-loading.scss';

/** Shared initial loading state for the reminders pane and Markdown blocks. */
export function RemindersLoading({ compact = false }: { compact?: boolean }) {
  const reduceMotion = useObsidianReducedMotion();
  return <div className={`reminders-loading${compact ? ' reminders-loading--compact' : ''}${reduceMotion ? ' reminders-loading--still' : ''}`}>
    <LoadingIndicator label="Loading reminders" />
  </div>;
}
