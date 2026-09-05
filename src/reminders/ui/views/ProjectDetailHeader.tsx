import React, { memo } from 'react';

import { ProgressMeter } from '../../components/ProgressMeter';
import type { ProjectDetailHeaderViewModel } from './viewModels';
import { ThemeIcon } from '../../components/theme-icon';

export const ProjectDetailHeader = memo(function ProjectDetailHeader({
  project,
  header,
  hideTitle = false,
}: {
  project: string;
  hideTitle?: boolean;
  header: ProjectDetailHeaderViewModel;
}) {
  const progressColor = header.isComplete ? 'var(--text-success)' : header.accentColor;

  return (
    <div className="project-detail-header">
      {!hideTitle && <div className="project-detail-header-top">
        <h1 className="project-detail-title">{project}</h1>
      </div>}
      {header.total > 0 && (
        <div className="project-detail-header-bottom">
          <div className="project-detail-stats-text">
            <span className="project-detail-stat">
              <ThemeIcon size="xs" id="circle" />
              {header.activeCount}
              <span className="project-detail-stat-label">active</span>
            </span>
            <span className="project-detail-stat-dot">&middot;</span>
            <span className="project-detail-stat project-detail-stat-done">
              <ThemeIcon size="xs" id="circle-check" />
              {header.completedCount}
              <span className="project-detail-stat-label">done</span>
            </span>
          </div>
          <div className="premium-project-progress">
            <ProgressMeter
              percentage={header.completionPercentage}
              color={progressColor}
              label={`${project} completion`}
            />
            <span className="premium-project-percentage">{header.completionPercentage}%</span>
          </div>
        </div>
      )}
    </div>
  );
});
