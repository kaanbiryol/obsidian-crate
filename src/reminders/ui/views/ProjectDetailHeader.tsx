import React, { memo } from 'react';

import { ProgressMeter } from '../../components/ProgressMeter';
import type { ProjectDetailHeaderViewModel } from './viewModels';

export const ProjectDetailHeader = memo(function ProjectDetailHeader({
  project,
  header,
  hideTitle = false,
  rightContent,
  titleContent,
  metaContent,
}: {
  project: string;
  hideTitle?: boolean;
  header: ProjectDetailHeaderViewModel;
  rightContent?: React.ReactNode;
  titleContent?: React.ReactNode;
  metaContent?: React.ReactNode;
}) {
  const progressColor = header.isComplete ? 'var(--text-success)' : header.accentColor;

  return (
    <div className="project-detail-header">
      {(!hideTitle || rightContent) && <div className="project-detail-header-top">
        {!hideTitle && <div className="project-detail-title-row">
          <h1 className="project-detail-title">{project}</h1>
          {titleContent}
        </div>}
        {rightContent}
      </div>}
      {header.total === 0 && metaContent}
      {header.total > 0 && (
        <div className="project-detail-header-bottom">
          <div className="project-detail-stats-text">
            <span className="project-detail-stat">
              {header.activeCount} active
            </span>
            <span className="project-detail-stat-dot">&middot;</span>
            <span className="project-detail-stat">
              {header.completedCount} of {header.total} done
            </span>
            {metaContent}
          </div>
          <ProgressMeter
            className="project-detail-progress"
            percentage={header.completionPercentage}
            color={progressColor}
            label={`${project} completion`}
          />
        </div>
      )}
    </div>
  );
});
