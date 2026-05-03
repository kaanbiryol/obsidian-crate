import React from 'react';
import { Button } from '@heroui/react';
import {
	ArrowDown,
	Bell,
	RefreshCw,
	Settings,
} from 'lucide-react';
import type { DataMode, PullRefreshState } from '../types';

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
	showNotificationPrompt,
	onReload,
	onEnableNotifications,
}: {
	statusText: string | null;
	statusKind: DataMode | 'offline';
	updateAvailable: boolean;
	showNotificationPrompt: boolean;
	onReload: () => void;
	onEnableNotifications: () => void;
}) {
	const showStatusLine = Boolean(statusText && statusKind !== 'live');
	if (!showStatusLine && !updateAvailable && !showNotificationPrompt) return null;

	return (
		<div className="pwa-top-notices">
			{updateAvailable && (
				<div className="pwa-update-banner">
					<div className="pwa-update-banner__label">
						<span className="pwa-update-banner__dot" aria-hidden="true" />
						<span className="pwa-update-banner__text">Update available</span>
					</div>
					<button className="pwa-update-button" type="button" onClick={onReload} aria-label="Update to the latest version">
						Update
					</button>
				</div>
			)}
			{showStatusLine && <div className={`pwa-status-line is-${statusKind}`}>{statusText}</div>}
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

export function PwaPullRefreshIndicator({ pullRefresh }: { pullRefresh: PullRefreshState }) {
	const visible = pullRefresh.distance > 0 || pullRefresh.refreshing;
	const height = visible ? Math.min(82, Math.max(0, pullRefresh.distance)) : 0;
	const label = pullRefresh.refreshing ? 'Refreshing' : pullRefresh.ready ? 'Release to refresh' : null;
	const iconStyle: React.CSSProperties = pullRefresh.refreshing
		? {}
		: {
			transform: `rotate(${Math.round(pullRefresh.progress * 360)}deg) scale(${pullRefresh.ready ? 1.08 : 1})`,
		};

	return (
		<div
			className={`pwa-pull-refresh${visible ? ' is-visible' : ''}${pullRefresh.ready ? ' is-ready' : ''}${pullRefresh.refreshing ? ' is-refreshing' : ''}`}
			style={{ height: `${height}px` }}
			aria-hidden={!visible}
		>
			<div className="pwa-pull-refresh__inner">
				<div className="pwa-pull-refresh__glyph" style={iconStyle}>
					{pullRefresh.refreshing ? <RefreshCw size={19} /> : <ArrowDown size={19} />}
				</div>
				{label && <div className="pwa-pull-refresh__label">{label}</div>}
			</div>
		</div>
	);
}

export function PwaLoadingSkeleton() {
	return (
		<div className="pwa-loading-state" aria-label="Loading reminders">
			<div className="pwa-skeleton-header">
				<div className="pwa-skeleton-line is-title" />
				<div className="pwa-skeleton-line is-meta" />
			</div>
			<div className="pwa-skeleton-list">
				{[0, 1, 2, 3, 4].map((item) => (
					<div className="pwa-skeleton-row" key={item}>
						<div className="pwa-skeleton-check" />
						<div className="pwa-skeleton-body">
							<div className="pwa-skeleton-line" />
							<div className="pwa-skeleton-line is-short" />
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
