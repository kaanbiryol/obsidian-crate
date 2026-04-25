import React, { memo } from 'react';
import { ChevronRight, Circle, CheckCircle2, Sparkles } from 'lucide-react';

import type { AnimationConfig } from '../../types/componentAdapter';
import { ShadowDOMNativeMotionButton } from '../ShadowDOMButton';
import type { BrowseProjectCardViewModel } from './viewModels';

const MiniProgressBar = memo(function MiniProgressBar({
  percentage,
  accentColor,
  isComplete
}: {
  percentage: number;
  accentColor: string;
  isComplete: boolean;
}) {
  return (
    <div className="premium-mini-progress">
      <div
        className="premium-mini-progress-fill"
        style={{
          width: `${percentage}%`,
          backgroundColor: isComplete ? '#22c55e' : accentColor,
          boxShadow: percentage > 0 ? `0 0 4px ${isComplete ? '#22c55e' : accentColor}30` : 'none',
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
      whileTap={{ scale: 0.98 }}
    >
      <div className="premium-project-content">
        <div className="premium-project-left">
          <div className="premium-project-accent-wrapper">
            <div
              className="premium-project-accent"
              style={{
                backgroundColor: accentColor,
                boxShadow: `0 0 6px ${accentColor}40`,
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
                  <Sparkles size={12} />
                  All done
                </span>
              ) : (
                <>
                  <span className="premium-project-stat">
                    <Circle size={10} strokeWidth={2.5} />
                    {stats.active}
                  </span>
                  {stats.completed > 0 && (
                    <span className="premium-project-stat premium-project-stat-done">
                      <CheckCircle2 size={10} strokeWidth={2.5} />
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

          <ChevronRight
            size={16}
            className="premium-project-chevron"
            strokeWidth={2}
          />
        </div>
      </div>
    </ShadowDOMNativeMotionButton>
  );
});
