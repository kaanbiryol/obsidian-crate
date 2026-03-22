import React, { memo } from 'react';
import { getFontSize, getFontWeight } from '../ui/themes';

interface ViewHeaderProps {
  title: string;
  count: number;
  overdueCount?: number;
  className?: string;
  style?: React.CSSProperties;
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
  style = {},
  rightContent,
  large = false
}: ViewHeaderProps) {
  const titleColor = 'var(--text-normal)';
  const subtitleColor = 'var(--text-muted)';
  const backgroundColor = 'transparent';

  const titleFontSize = large ? '28px' : '20px';

  return (
    <div
      className={`view-header ${className}`}
      style={{
        flexShrink: 0,
        padding: large ? '16px 20px 12px' : '12px 16px 8px',
        background: backgroundColor,
        borderBottom: '1px solid var(--background-modifier-border)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        ...style
      }}
    >
      <div style={{ flex: 1 }}>
        <h1
          style={{
            fontSize: titleFontSize,
            fontWeight: getFontWeight('semibold'),
            color: titleColor,
            margin: 0,
            lineHeight: 1.2,
          }}
        >
          {title}
        </h1>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginTop: '4px',
            minHeight: '28px', // Fixed height to prevent layout shift when overdue chip appears
          }}
        >
          <span
            style={{
              fontSize: getFontSize('sm'),
              color: subtitleColor,
            }}
          >
            {count} {count === 1 ? 'reminder' : 'reminders'}
          </span>

          {overdueCount > 0 && (
            <span
              style={{
                padding: '4px 12px',
                background: 'var(--reminder-red, #e53935)',
                color: 'white',
                fontSize: '14px',
                fontWeight: 600,
                borderRadius: '12px',
              }}
            >
              {overdueCount} overdue
            </span>
          )}
        </div>
      </div>

      {rightContent && (
        <div style={{ flexShrink: 0 }}>
          {rightContent}
        </div>
      )}
    </div>
  );
});
