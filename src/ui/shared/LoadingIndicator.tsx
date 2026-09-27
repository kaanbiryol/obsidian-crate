import React from 'react';
import { SPINNER_SPOKES } from './spinner-spokes';

/** An omitted progress value shows the rotating spinner's full opacity trail. */
export function LoadingSpinner({ className, progress }: { className: string; progress?: number }) {
	return <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
		{SPINNER_SPOKES.map(({ transform, opacity }, index) => <rect
			key={index} x="11" y="2" width="2" height="5" rx="1" fill="currentColor"
			transform={transform}
			opacity={progress === undefined ? opacity : Math.max(0, Math.min(1, progress * 12 - index))}
		/>)}
	</svg>;
}

/** A quiet initial loading state; CSS delays its appearance to avoid quick flashes. */
export function LoadingIndicator({ label }: { label: string }) {
	return <div className="crate-content-loading" role="status" aria-label={label}>
		<LoadingSpinner className="crate-content-loading__spinner" />
	</div>;
}
