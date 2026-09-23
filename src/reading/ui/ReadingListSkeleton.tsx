import React from 'react';

/** Placeholders follow the library row layout without implying an empty list. */
export function ReadingListSkeleton() {
	return <div className="crate-reading__loading" role="status" aria-label="Loading Reading">
		<div className="crate-reading__loading-content" aria-hidden="true">
			<span className="crate-reading__loading-group crate-reading__loading-shape" />
			{Array.from({ length: 4 }, (_, index) => <div className="crate-reading__loading-row" key={index}>
				<span className="crate-reading__loading-source crate-reading__loading-shape" />
				<span className="crate-reading__loading-copy">
					<span className="crate-reading__loading-title crate-reading__loading-shape" />
					<span className="crate-reading__loading-meta crate-reading__loading-shape" />
				</span>
				<span className="crate-reading__loading-action crate-reading__loading-shape" />
			</div>)}
		</div>
	</div>;
}
