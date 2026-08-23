import { useEffect } from 'react';

export function usePwaZoomLock(): void {
	useEffect(() => {
		const preventGestureZoom = (event: Event) => event.preventDefault();

		document.addEventListener('gesturestart', preventGestureZoom, { passive: false });
		document.addEventListener('gesturechange', preventGestureZoom, { passive: false });

		return () => {
			document.removeEventListener('gesturestart', preventGestureZoom);
			document.removeEventListener('gesturechange', preventGestureZoom);
		};
	}, []);
}
