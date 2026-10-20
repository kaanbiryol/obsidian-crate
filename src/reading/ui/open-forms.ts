import { useEffect } from 'react';

let openForms = 0;

/** Registers a mounted capture or tag form, whose typed input an app update would discard. */
export function useOpenReadingForm(): void {
	useEffect(() => {
		openForms += 1;
		return () => { openForms -= 1; };
	}, []);
}

export const hasOpenReadingForm = (): boolean => openForms > 0;
