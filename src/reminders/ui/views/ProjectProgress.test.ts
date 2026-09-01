import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BrowseProjectCard } from './BrowseProjectCard';
import { ProjectDetailHeader } from './ProjectDetailHeader';

describe('project progress', () => {
	it('exposes browse and detail progress values accessibly', () => {
		const browseMarkup = renderToStaticMarkup(React.createElement(BrowseProjectCard, {
			card: {
				project: 'Work',
				stats: { active: 1, completed: 1, total: 2, completionPercentage: 50 },
				accentColor: 'red',
				isComplete: false,
			},
			onClick: vi.fn(),
			animationConfig: { enabled: false },
		}));
		const detailMarkup = renderToStaticMarkup(React.createElement(ProjectDetailHeader, {
			project: 'Work',
			header: {
				activeCount: 1,
				completedCount: 1,
				total: 2,
				completionPercentage: 50,
				isComplete: false,
				accentColor: 'red',
			},
		}));

		expect(browseMarkup).toContain('role="progressbar"');
		expect(browseMarkup).toContain('aria-valuenow="50"');
		expect(detailMarkup).toContain('aria-label="Work completion"');
		expect(detailMarkup).toContain('aria-valuenow="50"');
	});
});
