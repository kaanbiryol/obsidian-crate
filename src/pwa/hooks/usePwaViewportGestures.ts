import { useEffect } from 'react';

/** Keep native scrolling while preventing Safari's page-level pinch gestures. */
export function usePwaViewportGestures(): void {
	useEffect(() => {
		const preventZoom = (event: Event) => event.preventDefault();
		document.addEventListener('gesturestart', preventZoom, { passive: false });
		document.addEventListener('gesturechange', preventZoom, { passive: false });
		return () => {
			document.removeEventListener('gesturestart', preventZoom);
			document.removeEventListener('gesturechange', preventZoom);
		};
	}, []);
}
