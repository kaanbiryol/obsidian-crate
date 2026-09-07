import React, { useState } from 'react';
import type { PwaPreferences } from '../preferences';
import { PwaButton as Button } from './PwaButton';
import {
	Check,
	ChevronDown,
	LogOut,
	Monitor,
	Moon,
	Sun,
} from 'lucide-react';
import { ModalHeader } from '@/ui/shared/ModalHeader';
import { useDialogFocus } from '../hooks/useDialogFocus';
import type { PwaThemePreference } from '../theme';
import type { PushState, StoredConfig } from '../types';
import { PwaModalSheet } from './PwaModalSheet';
import { HomeScreenInstallInstructions } from './HomeScreenInstall';
import type { HomeScreenPlatform } from '../hooks/useHomeScreenInstall';

export function SettingsSheet({
	config,
	homeScreenPlatform = null,
	defaultScreen,
	onPreferencesChange,
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
	homeScreenPlatform?: HomeScreenPlatform | null;
	defaultScreen: PwaPreferences['defaultScreen'];
	onPreferencesChange: (patch: Partial<PwaPreferences>) => void;
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
	const [upcomingDraft, setUpcomingDraft] = useState(String(config.upcomingDays));
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
				<ModalHeader
					title="Settings"
					closeLabel="Close settings"
					closeDisabled={loggingOut || isClosing}
					onClose={onClose}
				/>
				<div className="settings-panel">
					{homeScreenPlatform && <HomeScreenInstallInstructions platform={homeScreenPlatform} />}
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

					<section className="settings-panel__section" aria-labelledby="settings-reminders-title">
						<h3 id="settings-reminders-title" className="settings-panel__title">Reminders</h3>
						<div className="settings-group">
							<label className="settings-row settings-row--preference">
								<span className="settings-row__copy"><strong>Default screen</strong><span>Shown when Crate opens.</span></span>
								<span className="settings-preference-control settings-preference-control--select">
								<select className="settings-preference-input" value={defaultScreen} onChange={(event) => onPreferencesChange({ defaultScreen: event.currentTarget.value as PwaPreferences['defaultScreen'] })}>
									<option value="today">Today</option>
									<option value="inbox">Inbox</option>
									<option value="upcoming">Upcoming</option>
									<option value="browse">Browse</option>
								</select>
								<ChevronDown size={14} aria-hidden="true" />
								</span>
							</label>
							<label className="settings-row settings-row--preference">
								<span className="settings-row__copy"><strong>Upcoming range</strong><span>Days ahead to show.</span></span>
								<span className="settings-preference-control settings-preference-control--days">
								<input aria-label="Upcoming range (days)" className="settings-preference-input" type="number" inputMode="numeric" min={1} step={1} value={upcomingDraft}
									onChange={(event) => setUpcomingDraft(event.currentTarget.value)}
									onBlur={() => {
										const days = Number(upcomingDraft);
										if (Number.isSafeInteger(days) && days >= 1) {
											onPreferencesChange({ upcomingDays: days });
											setUpcomingDraft(String(days));
										} else setUpcomingDraft(String(config.upcomingDays));
									}}
									onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
								/>
								<span className="settings-preference-unit" aria-hidden="true">days</span>
								</span>
							</label>
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
								) : homeScreenPlatform === 'ios' ? (
									<span className="settings-status">Install first</span>
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
