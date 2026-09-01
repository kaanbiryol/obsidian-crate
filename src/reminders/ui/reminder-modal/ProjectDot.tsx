import type React from 'react';

import { getProjectColor } from '../../utils/projectColors';

export const ProjectDot: React.FC<{ projectName: string; isDark: boolean }> = ({ projectName, isDark }) => {
    const color = getProjectColor(projectName)[isDark ? 'dark' : 'light'].accent;

    return (
        <span className="project-picker-dot" style={{ backgroundColor: color }} aria-hidden="true" />
    );
};
