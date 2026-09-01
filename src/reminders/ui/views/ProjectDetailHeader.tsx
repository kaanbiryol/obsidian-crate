import React, { memo } from 'react';

import type { ProjectDetailHeaderViewModel } from './viewModels';
import { ThemeIcon } from '../../components/theme-icon';

export const ProjectDetailHeader = memo(function ProjectDetailHeader({
  project,
  header,
}: {
  project: string;
  header: ProjectDetailHeaderViewModel;
}) {
  const progressColor = header.isComplete ? 'var(--text-success)' : header.accentColor;

  return (
    <div className="project-detail-header">
      <div className="project-detail-header-top">
        <h1 className="project-detail-title">{project}</h1>
        {header.total > 0 && (
          <span
            className="project-detail-percentage"
            style={{ color: progressColor }}
          >
            {header.completionPercentage}%
          </span>
        )}
      </div>
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
          <div className="project-detail-progress-bar">
            <div
              className="project-detail-progress-fill"
              style={{
                width: `${header.completionPercentage}%`,
                backgroundColor: progressColor,
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
});
