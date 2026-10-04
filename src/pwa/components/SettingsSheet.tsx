import { pwaSyncState, refreshPwaSync, logoutPwaSync } from '../sync/state';
import { EncryptionSettings } from './EncryptionSettings';
import { ChevronRight } from 'lucide-react';
import { encryptionSnapshot, subscribeEncryption } from '../encryption-session';

import { TabSettings } from './TabSettings';
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { PwaPushStack } from './PwaPushStack';
import { ShortcutSettingsSheet } from './ShortcutSettingsSheet';
import type { PushedScreenHistory } from '../pushed-screen-history';
import { ModalHeader } from '@/ui/shared/ModalHeader';
import { PwaModalSheet } from './PwaModalSheet';
import { Button } from '@/ui/shared/Button';
import { SettingsRow } from './SettingsRow';
import { SettingsAction } from './SettingsAction';
import { SettingsSection } from './SettingsSection';
import { VersionSettings } from './VersionSettings';
import { DeviceStorageSettings } from './DeviceStorageSettings';
import { GeneralSettings } from './GeneralSettings';
import { ReminderSettings } from './ReminderSettings';
import { ReadingSettings } from '../reading/ReadingSettings';
import { HomeScreenInstallSteps } from './HomeScreenInstall';
import { useHomeScreenInstall } from '../hooks/useHomeScreenInstall';
import { usePwaPreferences } from '../hooks/usePwaPreferences';
import { useSheetTransition } from '../hooks/useSheetTransition';
import { useSettingsStore } from '../settings-context';
import { useAppUpdate } from './PwaUpdateProvider';
import { PwaUpdateNotice, PwaUpdateFeedback } from './PwaUpdateNotice';
import type { PwaPreferences } from '../preferences';

type SettingsAction = 'refresh' | 'export-reminders' | 'export-reading' | 'logout';

export function SettingsSheet({ onReviewReminders, onOpenEnd, navigation }: { navigation: PushedScreenHistory<'shortcut' | 'logout' | 'install'>; onReviewReminders: () => void; onOpenEnd: () => void }) {
	const store = useSettingsStore();
	const appUpdate = useAppUpdate();
	const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
	const { reminders, reading } = snapshot;
	const { preferences, updatePreferences } = usePwaPreferences();
	const homeScreen = useHomeScreenInstall();
	const encryption = useSyncExternalStore(subscribeEncryption, encryptionSnapshot);
	const finish = useCallback(() => store.setOpen(false), [store]);
	const transition = useSheetTransition(finish);
	const { page: detailPage, entryId, immediate, closing } = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot);
	const page = detailPage ?? 'settings';
	const [pending, setPending] = useState<ReadonlySet<SettingsAction>>(new Set());
	const working = useRef(new Set<SettingsAction>());
	const busy = pending.size > 0;
	const exclusive = appUpdate.updating || pending.has('logout');
	const [message, setMessage] = useState<string | null>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const { ready, unsynced } = pwaSyncState(snapshot);
	const attention = [reminders?.connected && reminders.attention ? 'Reminders: ' + reminders.attention : null, reading?.attention ? 'Reading: ' + reading.attention : null].filter(Boolean);
	const navigate = (next: 'settings' | 'shortcut' | 'logout' | 'install') => {
		setMessage(null);
		if (next === 'settings') navigation.back();
		else navigation.push(next);
	};
	const run = async (key: SettingsAction, action: () => void | Promise<unknown>) => {
		if (working.current.has(key) || working.current.has('logout')
			|| (key === 'logout' && working.current.size > 0)) return;
		working.current.add(key); setPending(new Set(working.current)); setMessage(null);
		try { await action(); }
		catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Could not complete this action. Try again.'); }
		finally { working.current.delete(key); setPending(new Set(working.current)); }
	};
	const changePreferences = (patch: Partial<PwaPreferences>) => {
		try { updatePreferences(patch); setMessage(null); }
		catch { setMessage('Could not save settings on this device.'); }
	};
	const refreshAll = () => refreshPwaSync(store.getSnapshot());
	const readingExport = reading?.onExport && <SettingsAction disabled={exclusive || pending.has('export-reading')} onClick={() => void run('export-reading', reading.onExport!)}>Export Reading data</SettingsAction>;
	const reminderExport = reminders?.onExport && <SettingsAction disabled={exclusive || pending.has('export-reminders')} onClick={() => void run('export-reminders', reminders.onExport!)}>Export unsynced reminders</SettingsAction>;

	const close = () => {
		if (exclusive || closing) return false;
		if (page !== 'settings') { navigate('settings'); return false; }
		transition.requestClose();
		return true;
	};
	const pageTitle = (screen: typeof page) => ({ settings: 'Settings', shortcut: 'Set up iPhone shortcut', logout: 'Log out of Crate?', install: 'Add to home screen' })[screen];
	const title = pageTitle(page === 'shortcut' ? 'settings' : page);
	const header = (screen: typeof page) => <>
		<ModalHeader title={pageTitle(screen)} navigation={screen === 'settings' ? 'dismiss' : 'back'} closeLabel={screen === 'settings' ? 'Close settings' : 'Back to settings'}
			closeDisabled={exclusive || closing || transition.isClosing} onClose={close} />
		{page === screen && message && <p className="settings-feedback" role="alert">{message}</p>}
	</>;
	return <PwaModalSheet isOpen={!transition.isClosing} onClose={close} onCloseEnd={transition.finishClose}
		onOpenEnd={() => { onOpenEnd(); if (store.getSnapshot().syncRequested) panelRef.current?.querySelector('[data-settings-sync]')?.scrollIntoView({ block: 'start' }); }} variant="settings" label={title} dismissible={!exclusive && !transition.isClosing}>
		<aside data-pwa-back={!!detailPage && !exclusive && !closing} className="settings-sheet settings-sheet--unified outline-none" aria-busy={busy || transition.isClosing} tabIndex={-1}>
			<div className="settings-page-stack" inert={detailPage === 'shortcut'} aria-hidden={detailPage === 'shortcut'}>
			<PwaPushStack page={detailPage === 'shortcut' ? null : detailPage} entryId={detailPage === 'shortcut' ? null : entryId} immediate={immediate} onBackComplete={navigation.finishBack} rootRef={panelRef}
				rootHeader={header('settings')} renderHeader={header}
				rootClassName="settings-panel settings-main" detailClassName="settings-panel settings-detail" renderPage={subpage => <>
				{subpage === 'install' && <div className="settings-install-instructions pwa-home-screen-instructions">
					{homeScreen.platform ? <HomeScreenInstallSteps platform={homeScreen.platform} encrypted={encryption.status === 'ready' || reading?.encryption?.status === 'ready'} />
						: <p>Crate is already installed on this device.</p>}
				</div>}
				{subpage === 'logout' && <div className="settings-subpage">
					<p>This logs out of Reading and Reminders and clears their offline data and drafts from this device. Your synced data stays on the server.</p>
					{unsynced && <p className="settings-attention">There are unsynced or unverified changes on this device. Sync or review them before logging out.</p>}
					{(reminderExport || readingExport) && <div className="settings-recovery-actions">{reminderExport}{readingExport}</div>}
					{reminders?.recovery}
					<div className="settings-actions">
						<Button variant="outline" size="touch" disabled={exclusive} onClick={() => navigate('settings')}>Cancel</Button>
						<Button variant="outline" size="touch" tone="danger" disabled={exclusive || !ready} aria-disabled={busy || !ready} onClick={() => void run('logout', async () => {
							await logoutPwaSync(store.getSnapshot());
						})}>{pending.has('logout') ? 'Logging out…' : 'Log out and clear device data'}</Button>
					</div>
				</div>}
				</>}>
					{attention.length > 0 && <div className="settings-attention" role="status">
						{attention.map(text => <p key={text}>{text}</p>)}
						<Button size="touch" variant="ghost" onClick={() => { panelRef.current?.querySelector('[data-settings-sync]')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}>Review sync</Button>
					</div>}
					<PwaUpdateNotice disabled={busy || unsynced} />
					<PwaUpdateFeedback />
					<GeneralSettings preferences={preferences} onPreferencesChange={changePreferences} />
					<TabSettings preferences={preferences} onChange={changePreferences} />
					<ReminderSettings model={reminders} homeScreenPlatform={homeScreen.platform} onPreferencesChange={changePreferences} />
					<ReadingSettings ready={Boolean(reading?.ready)} connected={Boolean(reading?.connected)} unavailable={reading?.unavailable} onShortcut={() => navigate('shortcut')} />
					<div data-settings-sync=""><SettingsSection title="Sync">
						<SettingsRow title="Reminders"><span className="settings-value">{!reminders?.ready ? 'Checking…' : reminders.enabled === false ? reminders.status.label : reminders.connected ? reminders.status.label : 'Not connected'}</span></SettingsRow>
						<SettingsRow title="Reading" description={reading?.unavailable}><span className="settings-value">{!reading?.ready ? 'Checking…' : reading.enabled === false ? reading.status.label : reading.connected ? reading.status.label : 'Not connected'}</span></SettingsRow>
						{reminders?.connected && <SettingsRow className="settings-row--value"><span>Reminders folder</span><strong title={reminders.config.folderPath}>{reminders.config.folderPath}</strong></SettingsRow>}
						{reading?.issues}
						{readingExport}
						<SettingsAction disabled={exclusive || pending.has('refresh') || !ready} aria-busy={pending.has('refresh')} onClick={() => void run('refresh', refreshAll)}>Refresh all</SettingsAction>
						{reminders?.attention && <SettingsAction onClick={() => { finish(); onReviewReminders(); }}>Review reminders</SettingsAction>}
						{reminders?.recovery}
						{reminderExport}
					</SettingsSection></div>
					<DeviceStorageSettings />
					<EncryptionSettings reading={reading} remindersConnected={Boolean(reminders?.connected)} />
					{homeScreen.platform && <SettingsSection title="Web app">
						<Button className="settings-navigation-row" onClick={() => navigate('install')}>
							<span>Add to home screen</span><ChevronRight size={16} aria-hidden="true" />
						</Button>
					</SettingsSection>}
					<SettingsSection title="About">
						<VersionSettings />
					</SettingsSection>
					<div className="settings-account"><SettingsAction tone="danger" data-action="logout" disabled={exclusive || !ready} onClick={() => navigate('logout')}>Log out</SettingsAction></div>
			</PwaPushStack>
			</div>
			<ShortcutSettingsSheet open={detailPage === 'shortcut'} onClose={() => navigation.back()} onCloseEnd={navigation.finishBack}>
				{reading?.shortcut ?? <p>{reading?.ready ? 'Connect Reading in Obsidian to set up the shortcut.' : 'Loading Reading settings…'}</p>}
			</ShortcutSettingsSheet>
		</aside>
	</PwaModalSheet>;
}
