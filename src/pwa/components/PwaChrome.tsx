import { PwaUpdateButton } from '../update/PwaUpdateNotice';
import { LoadingSpinner } from '@/ui/shared/LoadingIndicator';
import React, { type RefObject, useContext, useLayoutEffect, useRef, useState } from 'react';
import { FeatureNavigationContext } from '../navigation/feature-navigation';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { PwaButton as Button } from './PwaButton';
import {
	Bell,
} from 'lucide-react';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import { PwaConnectionBanner } from './PwaConnectionBanner';
import { createPwaOpeningScreenHtml } from '../shell/opening-screen';
import { resolvePwaOpeningDestination } from '../navigation/opening-destination';
import { loadPwaPreferences } from '../settings/preferences';
import { createPwaUpdateScreenHtml } from '../shell/update-screen';
import { IconButton } from '@/ui/shared/IconButton';
import { useReducedMotion } from '@/ui/shared/useReducedMotion';
import { PWA_FADE, PWA_FADE_TIMING } from '@/ui/shared/navigation/motion';
import type { NotificationPrompt } from '../reminders/usePwaStatus';

function PwaSettingsButton({
	settingsOpen,
	onToggleSettings,
}: {
	settingsOpen: boolean;
	onToggleSettings: () => void;
}) {
	return (
		<IconButton
			icon="settings" size="large" iconSize="l"
			className="pwa-header-settings-button"
			type="button"
			data-action="toggle-settings"
			label={settingsOpen ? 'Close settings' : 'Open settings'}
			aria-haspopup="dialog"
			aria-expanded={settingsOpen}
			onClick={onToggleSettings}
		/>
	);
}

export function PwaHeaderActions({
	settingsOpen,
	onToggleSettings,
	showSettings = true,
	children,
}: {
	settingsOpen: boolean;
	onToggleSettings: () => void;
	showSettings?: boolean;
	children?: React.ReactNode;
}) {
	if (!showSettings && !children) return null;
	return (
		<div className="pwa-header-actions crate-view-header-actions">
			{showSettings && <PwaUpdateButton />}
			{children}
			{showSettings && <PwaSettingsButton settingsOpen={settingsOpen} onToggleSettings={onToggleSettings} />}
		</div>
	);
}

export function PwaTopNotices({
	statusText,
	onRetry,
	retrying,
	notificationPrompt,
	onEnableNotifications,
	children,
}: {
	statusText: string | null;
	/** Omitted while offline. */
	onRetry?: () => void;
	retrying: boolean;
	notificationPrompt: NotificationPrompt;
	onEnableNotifications: () => void;
	children?: React.ReactNode;
}) {
	const reducedMotion = useReducedMotion();
	const showNotices = Boolean(statusText || notificationPrompt || children);
	// Collapse the row, or the whole strip when it was the last notice, once
	// notifications turn on instead of jumping the list up.
	const collapse = { opacity: 0, height: 0, overflow: 'hidden' as const, transition: reducedMotion ? { duration: 0 } : PWA_FADE };
	const collapseStrip = { ...collapse, paddingTop: 0, paddingBottom: 0 };

	return (
		<AnimatePresence initial={false}>
			{showNotices && (
				<motion.div key="notices" className="pwa-top-notices" exit={collapseStrip}>
					{statusText && <PwaConnectionBanner text={statusText} onRetry={onRetry} retrying={retrying} />}
					{children}
					<AnimatePresence initial={false}>
						{notificationPrompt && (
							<motion.div key="notification-prompt" className="pwa-notification-prompt" exit={collapse}>
								<Bell className="pwa-notification-prompt__icon" size={14} aria-hidden="true" />
								{notificationPrompt === 'blocked'
									? <span className="pwa-notification-prompt__copy" role="status">Notifications are blocked. Allow them in settings, then reopen Crate.</span>
									: <>
										<span className="pwa-notification-prompt__copy">Get alerts when reminders are due</span>
										<Button className="pwa-inline-button pwa-raised-button pwa-notification-prompt__enable" type="button"
											disabled={notificationPrompt === 'pending'} onClick={onEnableNotifications}>
											Enable
										</Button>
									</>}
							</motion.div>
						)}
					</AnimatePresence>
				</motion.div>
			)}
		</AnimatePresence>
	);
}

/** Matches .pwa-pull-refresh__inner in host/reminders-view.scss. */
const PULL_GLYPH_SIZE = 28;
/** The release and refresh settle; tokens.$easing-settle is the same curve. */
const PULL_SETTLE_TIMING = { duration: 380, easing: PWA_FADE_TIMING.easing };

export function PwaPullRefreshIndicator({
	enabled,
	onRefresh,
	scrollSelector = '.pwa-reminders-view .ios-scroll',
}: {
	enabled: boolean;
	onRefresh: () => Promise<void>;
	scrollSelector?: string;
}) {
	const isPresent = useIsPresent();
	const pullRefresh = usePullToRefresh(enabled && isPresent, onRefresh, scrollSelector);
	const visible = pullRefresh.distance > 0 || pullRefresh.refreshing;
	const pulling = visible && !pullRefresh.refreshing;
	const indicator = useRef<HTMLDivElement>(null), glyph = useRef<HTMLDivElement>(null);
	usePullOffset(indicator, glyph, pullRefresh.distance, pulling, scrollSelector);
	const label = pullRefresh.refreshing
		? 'Refreshing'
		: pullRefresh.ready
			? 'Release to refresh'
			: 'Pull to refresh';

	return (
		<div
			ref={indicator}
			className={`pwa-pull-refresh${visible ? ' is-visible' : ''}${pullRefresh.ready ? ' is-ready' : ''}${pullRefresh.refreshing ? ' is-refreshing' : ''}${pulling ? ' is-pulling' : ''}`}
			role="status"
			aria-label={visible ? label : undefined}
			aria-hidden={!visible}
		>
			<div ref={glyph} className="pwa-pull-refresh__inner" aria-hidden="true">
				<LoadingSpinner className="pwa-pull-refresh__glyph" progress={pullRefresh.refreshing ? undefined : pullRefresh.progress} />
			</div>
		</div>
	);
}

/** Moves the content after the indicator down by `distance` and keeps the glyph centered in
 * the gap, with transforms only: the indicator takes no layout space, so a pull never reflows
 * the list. The finger drives each frame; a release or refresh settles from where it shows. */
function usePullOffset(indicatorRef: RefObject<HTMLDivElement | null>, glyphRef: RefObject<HTMLDivElement | null>,
	distance: number, pulling: boolean, scrollSelector: string): void {
	const reduceMotion = useReducedMotion();
	const shifted = useRef<HTMLElement[]>([]);
	const settling = useRef<Animation[]>([]);
	const shown = useRef(0);
	useLayoutEffect(() => {
		const indicator = indicatorRef.current, glyph = glyphRef.current;
		if (!indicator || !glyph) return;
		const owner = indicator.ownerDocument.defaultView ?? window;
		if (!shifted.current.length && distance > 0) shifted.current = contentAfter(indicator, scrollSelector, owner);
		const moves: Array<[HTMLElement, string]> = [
			[glyph, `translateY(${(distance - PULL_GLYPH_SIZE) / 2}px)`],
			...shifted.current.map(node => [node, `translateY(${distance}px)`] as [HTMLElement, string]),
		];
		const settle = !pulling && !reduceMotion && shown.current !== distance;
		shown.current = distance;
		// A settle still running continues from where it shows.
		const from = settle ? moves.map(([node]) => owner.getComputedStyle(node).transform) : [];
		for (const animation of settling.current) animation.cancel();
		settling.current = [];
		for (const [node, to] of moves) node.style.setProperty('transform', to);
		const release = () => {
			if (distance) return;
			// At rest the content keeps no transform, so it is no containing block for fixed layers.
			for (const node of shifted.current) node.style.removeProperty('transform');
			shifted.current = [];
		};
		if (!settle) { release(); return; }
		settling.current = moves.map(([node, to], index) => node.animate([{ transform: from[index]! }, { transform: to }], PULL_SETTLE_TIMING));
		settling.current[0]!.onfinish = release;
	}, [indicatorRef, glyphRef, distance, pulling, scrollSelector, reduceMotion]);
	useLayoutEffect(() => () => {
		for (const animation of settling.current) animation.cancel();
		for (const node of shifted.current) node.style.removeProperty('transform');
	}, []);
}

/** The in-flow content after `indicator`, at each level up to the one that holds the pulled
 * scroller: what a pull moves down. Positioned layers, like a floating add button, stay.
 * A list scrolling the document moves its children instead: a transform on the list itself
 * would carry its fixed header cover down over the first rows. */
function contentAfter(indicator: HTMLElement, scrollSelector: string, owner: Window): HTMLElement[] {
	const after: HTMLElement[] = [];
	for (let level: Element = indicator; level.parentElement; level = level.parentElement) {
		for (let next = level.nextElementSibling; next; next = next.nextElementSibling) {
			if (/absolute|fixed/.test(owner.getComputedStyle(next).position)) continue;
			if (next instanceof HTMLElement && next.dataset.documentScroll === 'true') after.push(...next.children as HTMLCollectionOf<HTMLElement>);
			else after.push(next as HTMLElement);
		}
		if (level.parentElement.querySelector(scrollSelector)) return after;
	}
	return [];
}

export function PwaLaunchSplash({ updating = false }: { updating?: boolean }) {
	// Reuse the shell's embedded logo so launch and reload need no image fetch.
	const [updateHtml] = useState(() => createPwaUpdateScreenHtml(
		document.querySelector<HTMLImageElement>('#pwa-update-transition img')?.getAttribute('src') ?? undefined,
	));
	// Enrollment cleans the URL while this screen is visible. Keep its original
	// destination until the real shell is ready so the title cannot jump back.
	const [openingHtml] = useState(() => createPwaOpeningScreenHtml(resolvePwaOpeningDestination(location.search, loadPwaPreferences().defaultScreen)));
	const navigation = useContext(FeatureNavigationContext);
	const requested = navigation?.destination;
	// Feature entry can happen long after launch, while its chunk or data is
	// still loading. Paint the dock destination throughout that handoff, and
	// follow another tap without waiting for the full reminder shell to mount.
	const destinationHtml = navigation?.section === 'reminders' && requested?.section === 'reminders'
		? createPwaOpeningScreenHtml(resolvePwaOpeningDestination(`?tab=${requested.tab}`))
		: openingHtml;
	return (
		<div
			className={`pwa-launch-splash${updating ? ' is-updating' : ''}`}
			role="status"
			aria-label={updating ? 'Updating Crate' : 'Loading Crate'}
			dangerouslySetInnerHTML={{ __html: updating ? updateHtml : destinationHtml }}
		/>
	);
}
