import { useCallback, useRef, useState } from 'react';
import { applyPwaUpdate } from '../apply-update';
import type { ShowToast } from '../types';

export function usePwaUpdate(showToast: ShowToast) {
	const [updating, setUpdating] = useState(false);
	const inFlight = useRef(false);
	const update = useCallback(() => {
		if (inFlight.current) return;
		inFlight.current = true;
		setUpdating(true);
		void applyPwaUpdate().catch((error: unknown) => {
			showToast('error', error instanceof Error ? error.message : 'Update failed. Please try again.');
		}).finally(() => {
			inFlight.current = false;
			setUpdating(false);
		});
	}, [showToast]);
	return { updating, update };
}
