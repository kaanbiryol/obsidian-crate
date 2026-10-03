import React, { memo } from 'react';

import { ProgressMeter } from '../../components/ProgressMeter';
import { ShadowDOMNativeMotionButton } from '../../components/ShadowDOMNativeMotionButton';
import type { BrowseProjectCardViewModel } from './viewModels';
import { ThemeIcon } from '../../components/theme-icon';

export const BrowseProjectCard = memo(function BrowseProjectCard({
  card,
  onClick,
  label,
  hideChevron = false,
}: {
  card: BrowseProjectCardViewModel;
  label?: string;
  hideChevron?: boolean;
  onClick: () => void;
}) {
  const { project, stats, accentColor, isComplete } = card;

  return (
    <ShadowDOMNativeMotionButton
      onClick={onClick}
      className="premium-project-card"
      data-action="open-project"
      data-project={project}
      aria-label={`Open ${project}`}
      initial={false}
      animate={{ opacity: 1 }}
      transition={{ duration: 0 }}
    >
      <div className="premium-project-content">
        <div className="premium-project-left">
          <div className="premium-project-accent-wrapper">
            <div
              className="premium-project-accent"
              style={{
                backgroundColor: accentColor,
              }}
            />
          </div>

          <div className="premium-project-info">
            <div className="premium-project-name">{label ?? project}</div>

            <div className="premium-project-stats">
              {stats.total === 0 ? (
                <span className="premium-project-stat-empty">No reminders</span>
              ) : isComplete ? (
                <span className="premium-project-stat-complete">
                  <ThemeIcon size="xs" id="sparkles" />
                  All done
                </span>
              ) : (
                <>
                  <span className="premium-project-stat">
                    {stats.active} active
                  </span>
                  {stats.completed > 0 && (
                    <span className="premium-project-stat premium-project-stat-done">
                      <span className="premium-project-stat-separator" aria-hidden="true">·</span>
                      {stats.completed} done
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="premium-project-right">
          {stats.total > 0 && (
            <div className="premium-project-progress">
              {stats.completionPercentage > 0 && <ProgressMeter
                percentage={stats.completionPercentage}
                color={isComplete ? 'var(--text-success)' : accentColor}
                label={`${project} completion`}
              />}
              <span className="premium-project-percentage">
                {stats.completionPercentage}%
              </span>
            </div>
          )}

          <span className="premium-project-chevron-slot" aria-hidden="true">
            <ThemeIcon
              size="s"
              id="chevron-right"
              className={`premium-project-chevron${hideChevron ? ' premium-project-chevron--hidden' : ''}`}
            />
          </span>
        </div>
      </div>
    </ShadowDOMNativeMotionButton>
  );
});
