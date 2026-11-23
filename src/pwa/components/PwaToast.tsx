import { PWA_FADE } from '../../ui/shared/navigation/motion';
import { SyncIndicator } from '@/ui/shared/SyncIndicator';
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react';
import type { ToastState } from '../types';
import { PwaButton } from './PwaButton';

/** Shared presentation for application feedback and update notices. */
export function PwaToast({ toast, onDismiss }: { toast: ToastState | null; onDismiss?: () => void }) {
	return <AnimatePresence>{toast && <ToastSurface key={toast.id} toast={toast} onDismiss={onDismiss} />}</AnimatePresence>;
}

/** One message. A replaced toast fades out as plain text, so only the current one is announced or takes taps. */
function ToastSurface({ toast, onDismiss }: { toast: ToastState; onDismiss?: () => void }) {
	const reduceMotion = useReducedMotion(), present = useIsPresent();
	const isError = toast.kind === 'error';
	return <motion.div className={`toast is-${toast.kind}${toast.syncState ? ' has-sync-indicator' : ''}`}
		role={present ? isError ? 'alert' : 'status' : undefined} aria-hidden={present ? undefined : true} inert={!present}
		initial={{ opacity: reduceMotion ? 1 : 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
		transition={reduceMotion ? { duration: 0 } : PWA_FADE}
		aria-live={present ? isError ? 'assertive' : 'polite' : undefined} aria-atomic="true">{toast.syncState && <SyncIndicator state={toast.syncState} />}{toast.message}{toast.action && <PwaButton variant="ghost" size="compact" className="toast__action" onClick={() => { const action = toast.action; onDismiss?.(); action?.onSelect(); }}>{toast.action.label}</PwaButton>}</motion.div>;
}
