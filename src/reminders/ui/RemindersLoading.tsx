import { useObsidianReducedMotion } from './useObsidianReducedMotion';
import './reminders-loading.scss';

/** Shared initial loading state for the reminders pane and Markdown blocks. */
export function RemindersLoading({ compact = false }: { compact?: boolean }) {
  const reduceMotion = useObsidianReducedMotion();
  return (
    <div className={`reminders-loading${compact ? ' reminders-loading--compact' : ''}${reduceMotion ? ' reminders-loading--still' : ''}`} role="status" aria-live="polite" aria-label="Loading reminders">
      <div className="reminders-loading-preview" aria-hidden="true">
        {[0, 1, 2].map(row => (
          <div className="reminders-loading-row" key={row}>
            <span className="reminders-loading-check" />
            <div className="reminders-loading-lines">
              <span className="reminders-loading-line" />
              <span className="reminders-loading-detail" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
