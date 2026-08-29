import React from 'react';
import { Button } from '@heroui/react';
import {
	Check,
	LogOut,
	Monitor,
	Moon,
	Sun,
	X,
} from 'lucide-react';
import { useDialogFocus } from '../hooks/useDialogFocus';
import type { PwaThemePreference } from '../theme';
import type { PushState, StoredConfig } from '../types';
import { PwaModalSheet } from './PwaModalSheet';

export function SettingsSheet({
	config,
	push,
	themePreference,
	loggingOut,
	isClosing,
	onClose,
	onClosed,
	onEnablePush,
	onThemePreferenceChange,
	onLogout,
}: {
	config: StoredConfig;
	push: PushState;
	themePreference: PwaThemePreference;
	loggingOut: boolean;
	isClosing: boolean;
	onClose: () => void;
	onClosed: () => void;
	onEnablePush: () => void;
	onThemePreferenceChange: (preference: PwaThemePreference) => void;
	onLogout: () => void;
}) {
	const upcomingDays = `${config.upcomingDays} ${config.upcomingDays === 1 ? 'day' : 'days'}`;
	const notificationDescription = push.status
		?? (push.subscribed ? 'Reminders are enabled on this device.' : 'Get alerts when Crate is closed.');
	const { handleDialogKeyDown, setDialogRef } = useDialogFocus({
		activeKey: 'settings',
		escapeDisabled: loggingOut || isClosing,
		onEscape: onClose,
	});
	return (
		<PwaModalSheet
			isOpen={!isClosing}
			onClose={onClose}
			onCloseEnd={onClosed}
			variant="settings"
			detent="content"
			closeOnBackdrop={!loggingOut && !isClosing}
			onKeyDown={handleDialogKeyDown}
		>
			<aside ref={setDialogRef} className="settings-sheet" role="dialog" aria-modal="true" aria-label="Settings" aria-busy={loggingOut || isClosing} tabIndex={-1}>
				<div className="settings-sheet__header">
					<h2>Settings</h2>
					<Button isIconOnly className="settings-sheet__close" type="button" data-action="close-settings" aria-label="Close settings" isDisabled={loggingOut || isClosing} onClick={onClose}>
						<X size={18} />
					</Button>
				</div>
				<div className="settings-panel">
					<section className="settings-panel__section" aria-labelledby="settings-appearance-title">
						<h3 id="settings-appearance-title" className="settings-panel__title">Appearance</h3>
						<div className="settings-group">
							<div className="settings-row settings-row--theme">
								<div className="settings-row__copy">
									<strong>Theme</strong>
									<span>Choose a theme or follow this device.</span>
								</div>
								<div className="settings-theme-picker" role="group" aria-label="Theme">
									{([
										{ value: 'system', label: 'System', icon: Monitor },
										{ value: 'light', label: 'Light', icon: Sun },
										{ value: 'dark', label: 'Dark', icon: Moon },
									] satisfies Array<{ value: PwaThemePreference; label: string; icon: typeof Monitor }>).map((option) => {
										const Icon = option.icon;
										const active = themePreference === option.value;
										return (
											<Button
												key={option.value}
												className={`settings-theme-option${active ? ' is-active' : ''}`}
												type="button"
												data-theme={option.value}
												aria-pressed={active}
												onClick={() => onThemePreferenceChange(option.value)}
											>
												<Icon size={15} />
												<span>{option.label}</span>
											</Button>
										);
									})}
								</div>
							</div>
						</div>
					</section>

					<section className="settings-panel__section" aria-labelledby="settings-notifications-title">
						<h3 id="settings-notifications-title" className="settings-panel__title">Notifications</h3>
						<div className="settings-group">
							<div className="settings-row">
								<div className="settings-row__copy">
									<strong>Push notifications</strong>
									<span aria-live="polite">{notificationDescription}</span>
								</div>
								{push.subscribed ? (
									<span className="settings-status is-success"><Check size={12} /> On</span>
								) : push.supported ? (
									<Button className="settings-action-button" type="button" data-action="enable-push" onClick={onEnablePush}>
										Enable
									</Button>
								) : (
									<span className="settings-status">Not supported</span>
								)}
							</div>
						</div>
					</section>

					<section className="settings-panel__section" aria-labelledby="settings-sync-title">
						<h3 id="settings-sync-title" className="settings-panel__title">Sync</h3>
						<div className="settings-group">
							<div className="settings-row settings-row--value">
								<span>Folder</span>
								<strong title={config.folderPath}>{config.folderPath}</strong>
							</div>
							<div className="settings-row settings-row--value">
								<span>Upcoming window</span>
								<strong>{upcomingDays}</strong>
							</div>
							<div className="settings-row settings-row--value">
								<span>All-day alert</span>
								<strong>{config.allDayNotificationTime ?? 'Not set'}</strong>
							</div>
						</div>
					</section>

					<Button className="settings-logout-button" type="button" data-action="logout" isDisabled={loggingOut} onClick={onLogout}>
						<LogOut size={16} /> {loggingOut ? 'Logging out...' : 'Log out'}
					</Button>
				</div>
			</aside>
		</PwaModalSheet>
	);
}
