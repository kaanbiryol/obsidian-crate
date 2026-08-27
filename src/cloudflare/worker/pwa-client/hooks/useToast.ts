import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToastKind, ToastState } from '../types';

export function useToast(): {
	toast: ToastState | null;
	showToast: (kind: ToastKind, message: string) => void;
	clearToast: () => void;
} {
	const [toast, setToast] = useState<ToastState | null>(null);
	const timerRef = useRef<number | null>(null);

	const clearToast = useCallback(() => {
		if (timerRef.current !== null) {
			window.clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		setToast(null);
	}, []);

	const showToast = useCallback((kind: ToastKind, message: string) => {
		setToast({ kind, message });
		if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		const duration = kind === 'success' ? 1800 : kind === 'error' ? 4200 : 3200;
		timerRef.current = window.setTimeout(() => {
			timerRef.current = null;
			setToast(null);
		}, duration);
	}, []);

	useEffect(() => () => {
		if (timerRef.current !== null) window.clearTimeout(timerRef.current);
	}, []);

	return { toast, showToast, clearToast };
}
