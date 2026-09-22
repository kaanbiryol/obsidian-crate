import React, { memo } from 'react';

interface ViewHeaderProps {
  title: string;
  count: number;
  countUnit?: 'reminder' | 'project' | 'saved link';
  overdueCount?: number;
  className?: string;
  /** Optional right-side action content (e.g., settings button) */
  rightContent?: React.ReactNode;
  titleContent?: React.ReactNode;
  metaContent?: React.ReactNode;
  /** Use large title style (for fullscreen views) */
  large?: boolean;
  /** Hide count metadata while the initial reminder snapshot is loading. */
  showMeta?: boolean;
  /** Keep the metadata row's height reserved while its values are hidden. */
  reserveMetaSpace?: boolean;
}

/**
 * Shared view header component
 * Displays title, count, and optional overdue badge
 */
export const ViewHeader = memo(function ViewHeader({
  title,
  count,
  countUnit = 'reminder',
  overdueCount = 0,
  className = '',
  rightContent,
  titleContent,
  metaContent,
  large = false,
  showMeta = true,
  reserveMetaSpace = false,
}: ViewHeaderProps) {
  return (
    <div
      className={`view-header${large ? ' is-large' : ''} ${className}`}
    >
      <div className="view-header-copy">
        <div className="view-header-title-row">
          <h1 className="view-header-title">{title}</h1>
          {titleContent}
        </div>
        {(showMeta || reserveMetaSpace) && (
          <div
            className={`view-header-meta${showMeta ? '' : ' is-reserved'}`}
            aria-hidden={!showMeta}
          >
            <span className="view-header-count">
              {count} {countUnit}{count === 1 ? '' : 's'}
            </span>

            {overdueCount > 0 && (
              <span className="view-header-overdue">
                {overdueCount} overdue
              </span>
            )}
            {metaContent}
          </div>
        )}
      </div>

      {rightContent && (
        <div className="view-header-actions">
          {rightContent}
        </div>
      )}
    </div>
  );
});
