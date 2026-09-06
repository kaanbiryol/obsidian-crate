import React from 'react';
import { PwaButton as Button } from './PwaButton';
import {
	Bell,
	RefreshCw,
	Settings,
} from 'lucide-react';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import type { DataMode } from '../types';

function PwaSettingsButton({
	settingsOpen,
	onToggleSettings,
}: {
	settingsOpen: boolean;
	onToggleSettings: () => void;
}) {
	return (
		<button
			className={`pwa-header-settings-button${settingsOpen ? ' is-active' : ''}`}
			type="button"
			data-action="toggle-settings"
			aria-label={settingsOpen ? 'Close settings' : 'Open settings'}
			aria-pressed={settingsOpen}
			onClick={onToggleSettings}
		>
			<Settings size={22} strokeWidth={2.1} />
		</button>
	);
}

export function PwaHeaderActions({
	settingsOpen,
	statusText,
	statusKind,
	refreshing,
	onRefresh,
	onToggleSettings,
}: {
	settingsOpen: boolean;
	statusText: string | null;
	statusKind: DataMode | 'offline';
	refreshing: boolean;
	onRefresh: () => void;
	onToggleSettings: () => void;
}) {
	return (
		<div className="pwa-header-actions">
			<button
				className={`pwa-header-sync-button is-${statusKind}${refreshing ? ' is-refreshing' : ''}`}
				type="button"
				data-action="refresh-header"
				aria-label={statusText ? `Refresh reminders. ${statusText}` : 'Refresh reminders'}
				onClick={onRefresh}
			>
				<RefreshCw size={22} strokeWidth={2.1} />
				<span className="pwa-header-sync-button__dot" aria-hidden="true" />
			</button>
			<PwaSettingsButton settingsOpen={settingsOpen} onToggleSettings={onToggleSettings} />
		</div>
	);
}

export function PwaTopNotices({
	statusText,
	statusKind,
	updateAvailable,
	updating,
	showNotificationPrompt,
	onReload,
	onEnableNotifications,
}: {
	statusText: string | null;
	statusKind: DataMode | 'offline';
	updateAvailable: boolean;
	updating: boolean;
	showNotificationPrompt: boolean;
	onReload: () => void;
	onEnableNotifications: () => void;
}) {
	const showStatusLine = Boolean(statusText && statusKind !== 'live');
	const showNotices = showStatusLine || updateAvailable || showNotificationPrompt;
	if (!showNotices) return null;

	return (
		<div className="pwa-top-notices">
			{updateAvailable && (
				<div className="pwa-update-banner" role="status">
					<span className="pwa-update-banner__text">Update available</span>
					<button className="pwa-update-button" type="button" onClick={onReload} disabled={updating} aria-busy={updating} aria-label="Update to the latest version">
						{updating ? 'Updating…' : 'Update'}
					</button>
				</div>
			)}
			{showStatusLine && <div className={`pwa-status-line is-${statusKind}`} role="status">{statusText}</div>}
			{showNotificationPrompt && (
				<div className="pwa-notification-prompt">
					<div className="pwa-notification-prompt__icon">
						<Bell size={16} />
					</div>
					<div className="pwa-notification-prompt__copy">
						<strong>Enable notifications</strong>
						<span>Get reminder alerts from this Home Screen app.</span>
					</div>
					<Button className="pwa-inline-button" type="button" onClick={onEnableNotifications}>
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
}: {
	enabled: boolean;
	onRefresh: () => Promise<void>;
}) {
	const pullRefresh = usePullToRefresh(enabled, onRefresh);
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
				<svg className="pwa-pull-refresh__glyph" viewBox="0 0 24 24" fill="none">
					{Array.from({ length: 12 }, (_, index) => (
						<rect
							key={index}
							x="11" y="2" width="2" height="5" rx="1"
							fill="currentColor"
							transform={`rotate(${index * 30} 12 12)`}
							opacity={pullRefresh.refreshing ? (index + 1) / 12 : Math.max(0, Math.min(1, pullRefresh.progress * 12 - index))}
						/>
					))}
				</svg>
			</div>
		</div>
	);
}

export function PwaLaunchSplash() {
	return (
		<div
			className="pwa-launch-splash"
			role="status"
			aria-label="Loading Crate"
		/>
	);
}
