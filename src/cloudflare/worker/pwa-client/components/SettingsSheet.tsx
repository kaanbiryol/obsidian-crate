import React from 'react';
import { Button } from '@heroui/react';
import { RefreshCw, X } from 'lucide-react';
import { isStandaloneApp } from '../config';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useSheetDrag } from '../hooks/useSheetDrag';
import type { PushState, StoredConfig } from '../types';

export function SettingsSheet({
	config,
	push,
	loggingOut,
	isClosing,
	onClose,
	onEnablePush,
	onRefresh,
	onLogout,
}: {
	config: StoredConfig;
	push: PushState;
	loggingOut: boolean;
	isClosing: boolean;
	onClose: () => void;
	onEnablePush: () => void;
	onRefresh: () => void;
	onLogout: () => void;
}) {
	const installHint = /iPad|iPhone|iPod/.test(navigator.userAgent) && !isStandaloneApp()
		? 'Add this app to your Home Screen from Safari to enable the best mobile experience and notifications on iPhone.'
		: isStandaloneApp()
			? 'This device is using the installed app experience.'
			: 'You can also install this app from your browser for faster access.';
	const { handleDialogKeyDown, setDialogRef } = useDialogFocus({
		activeKey: 'settings',
		escapeDisabled: loggingOut || isClosing,
		onEscape: onClose,
	});
	const sheetDrag = useSheetDrag({ disabled: loggingOut || isClosing, onDismiss: onClose });

	return (
		<div style={sheetDrag.backdropStyle} className={`settings-backdrop${isClosing ? ' is-closing' : ''}`} onClick={(event) => {
			if (!loggingOut && !isClosing && event.target === event.currentTarget) onClose();
		}}>
			<aside ref={setDialogRef} className={`settings-sheet${isClosing ? ' is-closing' : ''}${sheetDrag.dragClassName}`} role="dialog" aria-modal="true" aria-label="Settings" aria-busy={loggingOut || isClosing} tabIndex={-1} onKeyDown={handleDialogKeyDown}>
				<div className="pwa-sheet-grabber" aria-hidden="true" {...sheetDrag.handleProps}><span /></div>
				<div className="settings-sheet__header">
					<div>
						<h2>Settings</h2>
						<p>Notifications, install status, and the current reminder sync target for this device.</p>
					</div>
					<Button isIconOnly className="icon-button" type="button" data-action="close-settings" aria-label="Close settings" isDisabled={loggingOut || isClosing} onClick={onClose}>
						<X size={20} />
					</Button>
				</div>
				<div className="settings-panel">
					<div className="settings-panel__section">
						<div className="settings-panel__title">Notifications</div>
						<div className="settings-panel__row">
							<span>{push.subscribed ? 'Enabled' : 'Disabled'}</span>
							<Button className="secondary-button" type="button" data-action="enable-push" isDisabled={!push.supported || push.subscribed} onClick={onEnablePush}>
								{push.subscribed ? 'Enabled' : 'Enable'}
							</Button>
						</div>
						{push.status && <p className="settings-panel__hint">{push.status}</p>}
					</div>
					<div className="settings-panel__section">
						<div className="settings-panel__title">Install</div>
						<p className="settings-panel__hint">{installHint}</p>
					</div>
					<div className="settings-panel__section">
						<div className="settings-panel__title">Web app</div>
						<div className="settings-panel__row"><span>Folder</span><code>{config.folderPath}</code></div>
						<div className="settings-panel__row"><span>Upcoming days</span><code>{config.upcomingDays}</code></div>
						<div className="settings-panel__row"><span>All-day time</span><code>{config.allDayNotificationTime ?? 'none'}</code></div>
						<div className="settings-panel__actions">
							<Button className="secondary-button" type="button" data-action="refresh" onClick={onRefresh}><RefreshCw size={15} /> Refresh</Button>
							<Button className="secondary-button is-danger" type="button" data-action="logout" isDisabled={loggingOut} onClick={onLogout}>
								{loggingOut ? 'Logging out...' : 'Log out'}
							</Button>
						</div>
					</div>
				</div>
			</aside>
		</div>
	);
}
