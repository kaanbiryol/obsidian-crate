import React, { memo } from 'react';
import { Circle, CheckCircle2 } from 'lucide-react';

import type { ProjectDetailHeaderViewModel } from './viewModels';

export const ProjectDetailHeader = memo(function ProjectDetailHeader({
  project,
  header,
}: {
  project: string;
  header: ProjectDetailHeaderViewModel;
}) {
  const progressColor = header.isComplete ? '#22c55e' : header.accentColor;

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
              <Circle size={10} strokeWidth={2.5} />
              {header.activeCount}
              <span className="project-detail-stat-label">active</span>
            </span>
            <span className="project-detail-stat-dot">&middot;</span>
            <span className="project-detail-stat project-detail-stat-done">
              <CheckCircle2 size={10} strokeWidth={2.5} />
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
                boxShadow: header.completionPercentage > 0
                  ? `0 0 4px ${progressColor}30`
                  : 'none',
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
});
