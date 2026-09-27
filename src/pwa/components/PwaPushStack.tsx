import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { PWA_NAVIGATION_SPRING } from '../motion';

/** Full pages (fixed header + scrolling body) share push/pop motion and retain root state. */
export function PwaPushStack<Page extends string>({ page, entryId, immediate, onBackComplete, rootRef, children, rootHeader, renderHeader, renderPage, rootClassName = '', detailClassName = '' }: {
	page: Page | null;
	entryId: string | null;
	immediate: boolean;
	onBackComplete: () => void;
	rootRef: RefObject<HTMLDivElement | null>;
	children: ReactNode;
	rootHeader: ReactNode;
	renderHeader: (page: Page) => ReactNode;
	renderPage: (page: Page) => ReactNode;
	rootClassName?: string;
	detailClassName?: string;
}) {
	const reducedMotion = useReducedMotion();
	const [retained, setRetained] = useState(page ? { page, entryId } : null);
	const detailRef = useRef<HTMLDivElement>(null);
	const returnFocus = useRef<HTMLElement | null>(null);
	const previousPage = useRef<Page | null>(null);
	if (page && (page !== retained?.page || entryId !== retained.entryId)) setRetained({ page, entryId });
	useLayoutEffect(() => {
		if (page) {
			if (detailRef.current) detailRef.current.scrollTop = 0;
			detailRef.current?.parentElement?.querySelector<HTMLElement>('.reminder-modal-header-close')?.focus({ preventScroll: true });
		} else if (previousPage.current && returnFocus.current?.isConnected) {
			returnFocus.current.focus({ preventScroll: true });
		}
		previousPage.current = page;
	}, [page, entryId]);
	const instant = reducedMotion || immediate;
	const finish = () => { if (!page) { setRetained(null); onBackComplete(); } };
	useEffect(() => {
		if (page || !retained) return;
		// Recover a cancelled/suppressed animation without stranding navigation.
		const timer = window.setTimeout(() => { setRetained(null); onBackComplete(); }, 1000);
		return () => window.clearTimeout(timer);
	}, [page, retained, onBackComplete]);
	return <div className="pwa-push-stack">
		<div className="pwa-push-stack__root" inert={!!page} aria-hidden={!!page}
			onFocusCapture={event => { returnFocus.current = event.target; }}
			onPointerDownCapture={event => {
				if (event.target instanceof Element) returnFocus.current = event.target.closest<HTMLElement>('button, a, input, select, textarea');
			}}>
			{rootHeader}
			<div ref={rootRef} className={`pwa-push-stack__body ${rootClassName}`} inert={!!page} data-base-ui-swipe-ignore="">{children}</div>
		</div>
		<motion.div className="pwa-push-stack__detail" inert={!page} aria-hidden={!page}
			initial={false} animate={{ x: page ? '0%' : '100%' }}
			onAnimationComplete={finish} transition={instant ? { duration: 0 } : PWA_NAVIGATION_SPRING}>
			{retained && <Fragment key={retained.entryId}>
				{renderHeader(retained.page)}
				<div ref={detailRef} className={`pwa-push-stack__body ${detailClassName}`} data-base-ui-swipe-ignore="">{renderPage(retained.page)}</div>
			</Fragment>}
		</motion.div>
	</div>;
}
