import { createContext, useContext, type ReactNode } from 'react';
import { PwaToast } from '../components/PwaToast';
import { useToast } from '../hooks/useToast';
import type { ShowToast } from '../types';

const SyncFeedbackContext = createContext<ShowToast | null>(null);

/** Keep sync and logout feedback visible even when its feature screen is absent. */
export function SyncFeedbackProvider({ children }: { children: ReactNode }) {
	const { toast, showToast } = useToast();
	return <SyncFeedbackContext.Provider value={showToast}>
		{children}
		<div className="crate-reminders-ui"><PwaToast toast={toast} /></div>
	</SyncFeedbackContext.Provider>;
}

export function useSyncFeedback() {
	const showToast = useContext(SyncFeedbackContext);
	if (!showToast) throw new Error('Sync feedback must be mounted inside the PWA coordinator');
	return showToast;
}
