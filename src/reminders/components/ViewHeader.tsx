import React, { memo } from 'react';

interface ViewHeaderProps {
  title: string;
  count: number;
  overdueCount?: number;
  className?: string;
  /** Optional right-side action content (e.g., settings button) */
  rightContent?: React.ReactNode;
  /** Use large title style (for fullscreen views) */
  large?: boolean;
}

/**
 * Shared view header component
 * Displays title, count, and optional overdue badge
 */
export const ViewHeader = memo(function ViewHeader({
  title,
  count,
  overdueCount = 0,
  className = '',
  rightContent,
  large = false
}: ViewHeaderProps) {
  return (
    <div
      className={`view-header${large ? ' is-large' : ''} ${className}`}
    >
      <div className="view-header-copy">
        <h1 className="view-header-title">
          {title}
        </h1>
        <div className="view-header-meta">
          <span className="view-header-count">
            {count} {count === 1 ? 'reminder' : 'reminders'}
          </span>

          {overdueCount > 0 && (
            <span className="view-header-overdue">
              {overdueCount} overdue
            </span>
          )}
        </div>
      </div>

      {rightContent && (
        <div className="view-header-actions">
          {rightContent}
        </div>
      )}
    </div>
  );
});
