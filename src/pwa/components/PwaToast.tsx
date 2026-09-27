import type { ToastState } from '../types';

/** Shared presentation; each feature keeps its own toast lifetime and messages. */
export function PwaToast({ toast }: { toast: ToastState | null }) {
	if (!toast) return null;
	const isError = toast.kind === 'error';
	return <div className={`toast is-${toast.kind}`} role={isError ? 'alert' : 'status'}
		aria-live={isError ? 'assertive' : 'polite'} aria-atomic="true">{toast.message}</div>;
}
