import { PwaUpdateButton } from './PwaUpdateNotice';
import { LoadingSpinner } from '@/ui/shared/LoadingIndicator';
import React, { useState } from 'react';
import { useIsPresent } from 'motion/react';
import { PwaButton as Button } from './PwaButton';
import {
	Bell,
} from 'lucide-react';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import type { DataMode } from '../types';
import { createPwaOpeningScreenHtml } from '../opening-screen';
import { resolvePwaOpeningDestination } from '../opening-destination';
import { loadPwaPreferences } from '../preferences';
import { createPwaUpdateScreenHtml } from '../update-screen';
import { IconButton } from '@/ui/shared/IconButton';

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
	statusKind,
	showNotificationPrompt,
	onEnableNotifications,
	children,
}: {
	statusText: string | null;
	statusKind: DataMode | 'offline';
	showNotificationPrompt: boolean;
	onEnableNotifications: () => void;
	children?: React.ReactNode;
}) {
	const showStatusLine = Boolean(statusText && statusKind !== 'live');
	const showNotices = showStatusLine || showNotificationPrompt || children;
	if (!showNotices) return null;

	return (
		<div className="pwa-top-notices">
			{showStatusLine && <div className={`pwa-status-line is-${statusKind}`} role="status">{statusText}</div>}
			{children}
			{showNotificationPrompt && (
				<div className="pwa-notification-prompt">
					<div className="pwa-notification-prompt__icon">
						<Bell size={16} />
					</div>
					<div className="pwa-notification-prompt__copy">
						<strong>Enable notifications</strong>
						<span>Get alerts when reminders are due.</span>
					</div>
					<Button className="pwa-inline-button pwa-notification-prompt__enable" type="button" onClick={onEnableNotifications}>
						Enable
					</Button>
				</div>
			)}
		</div>
	);
}

export function PwaPullRefreshIndicator({
	enabled,
	onRefresh,
	scrollSelector,
}: {
	enabled: boolean;
	onRefresh: () => Promise<void>;
	scrollSelector?: string;
}) {
	const isPresent = useIsPresent();
	const pullRefresh = usePullToRefresh(enabled && isPresent, onRefresh, scrollSelector);
	const visible = pullRefresh.distance > 0 || pullRefresh.refreshing;
	const label = pullRefresh.refreshing
		? 'Refreshing'
		: pullRefresh.ready
			? 'Release to refresh'
			: 'Pull to refresh';

	return (
		<div
			className={`pwa-pull-refresh${visible ? ' is-visible' : ''}${pullRefresh.ready ? ' is-ready' : ''}${pullRefresh.refreshing ? ' is-refreshing' : ''}${visible && !pullRefresh.refreshing ? ' is-pulling' : ''}`}
			style={{ height: pullRefresh.distance }}
			role="status"
			aria-label={visible ? label : undefined}
			aria-hidden={!visible}
		>
			<div className="pwa-pull-refresh__inner" aria-hidden="true">
				<LoadingSpinner className="pwa-pull-refresh__glyph" progress={pullRefresh.refreshing ? undefined : pullRefresh.progress} />
			</div>
		</div>
	);
}

export function PwaLaunchSplash({ updating = false }: { updating?: boolean }) {
	// Reuse the shell's embedded logo so launch and reload need no image fetch.
	const [updateHtml] = useState(() => createPwaUpdateScreenHtml(
		document.querySelector<HTMLImageElement>('#pwa-update-transition img')?.getAttribute('src') ?? undefined,
	));
	// Enrollment cleans the URL while this screen is visible. Keep its original
	// destination until the real shell is ready so the title cannot jump back.
	const [openingHtml] = useState(() => createPwaOpeningScreenHtml(resolvePwaOpeningDestination(location.search, loadPwaPreferences().defaultScreen)));
	return (
		<div
			className={`pwa-launch-splash${updating ? ' is-updating' : ''}`}
			role="status"
			aria-label={updating ? 'Updating Crate' : 'Loading Crate'}
			dangerouslySetInnerHTML={{ __html: updating ? updateHtml : openingHtml }}
		/>
	);
}
