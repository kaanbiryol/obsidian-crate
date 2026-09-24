import type { PendingReading } from './storage';
import { ThemeIcon } from '@/reminders/components/theme-icon';
import { PwaButton } from '../components/PwaButton';
import { VersionSettings } from '../components/VersionSettings';

export function ReadingSettings({ pending, onShortcut, onRefresh, onExport, onUpdate, onLogout }: {
	pending: PendingReading[];
	onShortcut: () => void; onRefresh: () => void; onExport: () => void; onUpdate: () => void; onLogout: () => void;
}) {
	const issues = pending.filter(op => op.error || op.review);
	return <>
		<section className="settings-panel__section" aria-label="Reading">
			<h3 className="settings-panel__title">Reading</h3>
			<div className="settings-group">
				<div className="settings-row"><div className="settings-row__copy"><strong>Save from iPhone</strong><span>Add links from the share sheet.</span></div>
					<PwaButton className="settings-action-button" onClick={onShortcut} aria-label="Set up iPhone shortcut">Set up</PwaButton></div>
				<div className="settings-row"><div className="settings-row__copy"><strong>Offline reading</strong><span>Opened articles stay on this device, up to 50 articles or 20 MB.</span></div></div>
			</div>
		</section>
		<section className="settings-panel__section" aria-label="Sync">
			<h3 className="settings-panel__title">Sync</h3>
			<div className="settings-group">
				{issues.map(op => <div key={op.id} className="settings-row"><div className="settings-row__copy">
					<strong>{op.review ? 'Change needs review' : 'Couldn’t sync'}</strong>
					<span>{op.error || 'Export Reading data to review this change.'}</span>
				</div></div>)}
				<div className="settings-row"><PwaButton className="settings-action-button" onClick={onRefresh}>Refresh library</PwaButton></div>
				<div className="settings-row"><PwaButton className="settings-action-button" onClick={onExport}>Export Reading data</PwaButton></div>
				<div className="settings-row"><PwaButton className="settings-action-button" onClick={onUpdate}>Update app</PwaButton></div>
			</div>
		</section>
		<VersionSettings />
		<PwaButton className="settings-logout-button" onClick={onLogout}><ThemeIcon id="log-out" size="s" aria-hidden="true" />Log out and clear device data</PwaButton>
	</>;
}
