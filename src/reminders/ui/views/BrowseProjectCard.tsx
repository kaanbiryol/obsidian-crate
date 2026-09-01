import React, { memo } from 'react';

import type { AnimationConfig } from '../../types/componentAdapter';
import { ShadowDOMNativeMotionButton } from '../../components/ShadowDOMNativeMotionButton';
import type { BrowseProjectCardViewModel } from './viewModels';
import { ThemeIcon } from '../../components/theme-icon';

const MiniProgressBar = memo(function MiniProgressBar({
  percentage,
  accentColor,
  isComplete
}: {
  percentage: number;
  accentColor: string;
  isComplete: boolean;
}) {
  const progressColor = isComplete ? 'var(--text-success)' : accentColor;

  return (
    <div
      className="premium-mini-progress"
      role="progressbar"
      aria-label="Project completion"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percentage}
    >
      <div
        className="premium-mini-progress-fill"
        style={{
          width: `${percentage}%`,
          backgroundColor: progressColor,
        }}
      />
    </div>
  );
});

export const BrowseProjectCard = memo(function BrowseProjectCard({
  card,
  onClick,
  animationConfig,
}: {
  card: BrowseProjectCardViewModel;
  onClick: () => void;
  animationConfig: AnimationConfig;
}) {
  const { project, stats, accentColor, isComplete } = card;

  return (
    <ShadowDOMNativeMotionButton
      onClick={onClick}
      className="premium-project-card"
      data-action="open-project"
      data-project={project}
      initial={false}
      animate={{ opacity: 1 }}
      transition={{ duration: 0 }}
      whileTap={animationConfig.enabled ? { scale: 0.98 } : undefined}
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
            <div className="premium-project-name">{project}</div>

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
                    <ThemeIcon size="xs" id="circle" />
                    {stats.active}
                  </span>
                  {stats.completed > 0 && (
                    <span className="premium-project-stat premium-project-stat-done">
                      <ThemeIcon size="xs" id="circle-check" />
                      {stats.completed}
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
              <MiniProgressBar
                percentage={stats.completionPercentage}
                accentColor={accentColor}
                isComplete={isComplete}
              />
              <span className="premium-project-percentage">
                {stats.completionPercentage}%
              </span>
            </div>
          )}

          <ThemeIcon
            size="s"
            id="chevron-right"
            className="premium-project-chevron"
          />
        </div>
      </div>
    </ShadowDOMNativeMotionButton>
  );
});
