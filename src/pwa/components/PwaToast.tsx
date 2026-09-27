import { SyncIndicator } from '@/ui/shared/SyncIndicator';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { ToastState } from '../types';

/** Shared presentation; each feature keeps its own toast lifetime and messages. */
export function PwaToast({ toast }: { toast: ToastState | null }) {
	const reduceMotion = useReducedMotion();
	const isError = toast?.kind === 'error';
	return <AnimatePresence>{toast && <motion.div key="toast" className={`toast is-${toast.kind}${toast.syncState ? ' has-sync-indicator' : ''}`} role={isError ? 'alert' : 'status'}
		initial={{ opacity: reduceMotion ? 1 : 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
		transition={{ duration: reduceMotion ? 0 : 0.16, ease: 'easeOut' }}
		aria-live={isError ? 'assertive' : 'polite'} aria-atomic="true">{toast.syncState && <SyncIndicator state={toast.syncState} />}{toast.message}</motion.div>}</AnimatePresence>;
}
