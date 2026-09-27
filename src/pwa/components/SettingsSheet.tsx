import { TabSettings } from './TabSettings';
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { LogOut } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { PWA_NAVIGATION_SPRING } from '../motion';
import { ModalHeader } from '@/ui/shared/ModalHeader';
import { PwaModalSheet } from './PwaModalSheet';
import { PwaButton as Button } from './PwaButton';
import { SettingsRow } from './SettingsRow';
import { SettingsDisclosure } from './SettingsDisclosure';
import { VersionSettings } from './VersionSettings';
import { DeviceStorageSettings } from './DeviceStorageSettings';
import { GeneralSettings } from './GeneralSettings';
import { ReminderSettings } from './ReminderSettings';
import { ReadingSettings } from '../reading/ReadingSettings';
import { HomeScreenInstallInstructions } from './HomeScreenInstall';
import { useHomeScreenInstall } from '../hooks/useHomeScreenInstall';
import { usePwaPreferences } from '../hooks/usePwaPreferences';
import { useSheetTransition } from '../hooks/useSheetTransition';
import { useSettingsStore } from '../settings-context';
import { useAppUpdate } from './PwaUpdateProvider';
import { PwaUpdateNotice } from './PwaUpdateNotice';
import type { PwaPreferences } from '../preferences';
import type { CrateSection } from './FeatureSwitcherButton';

type SettingsAction = 'refresh' | 'export-reminders' | 'export-reading' | 'update' | 'logout';

export function SettingsSheet({ activeSection, onReviewReminders, onOpenEnd }: { activeSection: CrateSection; onReviewReminders: () => void; onOpenEnd: () => void }) {
	const store = useSettingsStore();
	const appUpdate = useAppUpdate();
	const { reminders, reading } = useSyncExternalStore(store.subscribe, store.getSnapshot);
	const { preferences, updatePreferences } = usePwaPreferences();
	const homeScreen = useHomeScreenInstall();
	const finish = useCallback(() => store.setOpen(false), [store]);
	const transition = useSheetTransition(finish);
	const [page, setPage] = useState<'settings' | 'shortcut' | 'logout'>(() => new URL(location.href).searchParams.get('setup') === 'shortcut' ? 'shortcut' : 'settings');
	const [syncOpen, setSyncOpen] = useState(false);
	const [pending, setPending] = useState<ReadonlySet<SettingsAction>>(new Set());
	const working = useRef(new Set<SettingsAction>());
	const busy = pending.size > 0;
	const exclusive = appUpdate.updating || pending.has('update') || pending.has('logout');
	const [message, setMessage] = useState<string | null>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const reducedMotion = useReducedMotion();
	const [subpage, setSubpage] = useState<'shortcut' | 'logout' | null>(page === 'settings' ? null : page);
	const backRef = useRef<HTMLDivElement>(null);
	const returnFocus = useRef<HTMLElement | null>(null);
	const ready = Boolean(reminders?.ready && reading?.ready);
	const unsynced = !ready || Boolean(reminders?.unsynced || reading?.unsynced);
	const attention = [reminders?.connected && reminders.attention ? 'Reminders: ' + reminders.attention : null, reading?.attention ? 'Reading: ' + reading.attention : null].filter(Boolean);
	const status = !ready ? 'Checking…' : attention.length ? 'Needs attention'
		: [reminders, reading].some(model => model?.connected && model.status.state === 'offline') ? 'Offline'
		: [reminders, reading].some(model => model?.connected && model.status.state !== 'synced') ? 'Changes pending'
		: reminders?.connected || reading?.connected ? 'All changes synced' : 'Not connected';
	const navigate = (next: typeof page) => {
		setMessage(null);
		if (next !== 'settings') {
			setSubpage(next);
			returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		}
		setPage(next);
		requestAnimationFrame(() => {
			if (next !== 'settings' && backRef.current) backRef.current.scrollTop = 0;
			if (next === 'settings' && returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
			else backRef.current?.closest('aside')?.querySelector<HTMLElement>('[aria-label="Back to settings"]')?.focus({ preventScroll: true });
		});
	};
	const run = async (key: SettingsAction, action: () => void | Promise<unknown>) => {
		if (working.current.has(key) || working.current.has('update') || working.current.has('logout')
			|| ((key === 'update' || key === 'logout') && working.current.size > 0)) return;
		working.current.add(key); setPending(new Set(working.current)); setMessage(null);
		try { await action(); }
		catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Could not complete this action. Try again.'); }
		finally { working.current.delete(key); setPending(new Set(working.current)); }
	};
	const changePreferences = (patch: Partial<PwaPreferences>) => {
		try { updatePreferences(patch); setMessage(null); }
		catch { setMessage('Could not save settings on this device.'); }
	};
	const refreshAll = async () => {
		const results = await Promise.allSettled([reminders?.connected ? reminders.onRefresh() : Promise.resolve(), reading?.onRefresh()]);
		const failure = results.find(result => result.status === 'rejected');
		if (failure?.status === 'rejected') throw failure.reason;
	};
	const exports = <>
		{reminders?.onExport && <Button size="touch" className="settings-action-button" disabled={exclusive || pending.has('export-reminders')} onClick={() => void run('export-reminders', reminders.onExport!)}>Export unsynced reminders</Button>}
		{reading?.onExport && <Button size="touch" className="settings-action-button" disabled={exclusive || pending.has('export-reading')} onClick={() => void run('export-reading', reading.onExport!)}>Export Reading data</Button>}
	</>;

	const close = () => {
		if (exclusive) return false;
		if (page !== 'settings') { navigate('settings'); return false; }
		transition.requestClose();
		return true;
	};
	const title = page === 'shortcut' ? 'Set up iPhone shortcut' : page === 'logout' ? 'Log out of Crate?' : 'Settings';
	return <PwaModalSheet isOpen={!transition.isClosing} onClose={close} onCloseEnd={transition.finishClose}
		onOpenEnd={onOpenEnd} variant="settings" label={title} dismissible={!exclusive && !transition.isClosing}>
		<aside className="settings-sheet settings-sheet--unified outline-none" aria-busy={busy || transition.isClosing} tabIndex={-1}>
			<ModalHeader title={title} navigation={page === 'settings' ? 'dismiss' : 'back'} closeLabel={page === 'settings' ? 'Close settings' : 'Back to settings'}
				closeDisabled={exclusive || transition.isClosing} onClose={close} />
			{page === 'settings' && <PwaUpdateNotice disabled={busy || unsynced} />}
			{message && <p className="settings-feedback" role="alert">{message}</p>}
			<div className="settings-stack" data-base-ui-swipe-ignore="">
				<motion.div layoutScroll ref={panelRef} className="settings-panel settings-main" inert={page !== 'settings'} aria-hidden={page !== 'settings'}
					initial={false} animate={{ x: reducedMotion ? 0 : page === 'settings' ? '0%' : '-25%', opacity: page === 'settings' ? 1 : 0 }}
					transition={reducedMotion ? { duration: 0 } : PWA_NAVIGATION_SPRING}>
					{attention.length > 0 && <div className="settings-attention" role="status">
						{attention.map(text => <p key={text}>{text}</p>)}
						<Button size="touch" variant="ghost" onClick={() => { setSyncOpen(true); requestAnimationFrame(() => panelRef.current?.querySelector('.settings-disclosure')?.scrollIntoView({ block: 'nearest' })); }}>Review sync</Button>
					</div>}
					<GeneralSettings preferences={preferences} onChange={changePreferences} />
					<TabSettings preferences={preferences} onChange={changePreferences} />
					<ReminderSettings model={reminders} homeScreenPlatform={homeScreen.platform} onPreferencesChange={changePreferences} />
					<ReadingSettings ready={Boolean(reading?.ready)} connected={Boolean(reading?.connected)} unavailable={reading?.unavailable} onShortcut={() => navigate('shortcut')} />
					<SettingsDisclosure title="Sync and device" summary={status} open={syncOpen} onOpenChange={setSyncOpen}>
						<div className="settings-group">
							<SettingsRow title="Reminders" description={!reminders?.ready ? 'Checking…' : reminders.connected ? reminders.status.label : 'Not connected'} />
							<SettingsRow title="Reading" description={reading?.unavailable ?? (!reading?.ready ? 'Checking…' : reading.connected ? reading.status.label : 'Not connected')} />
							{reading?.issues}
							<DeviceStorageSettings />
							{reminders?.connected && <SettingsRow className="settings-row--value"><span>Reminders folder</span><strong title={reminders.config.folderPath}>{reminders.config.folderPath}</strong></SettingsRow>}
						</div>
						<div className="settings-actions">
							<Button size="touch" className="settings-action-button" disabled={exclusive || pending.has('refresh') || !ready} onClick={() => void run('refresh', refreshAll)}>Refresh all</Button>
							{exports}
							{reminders?.attention && <Button size="touch" className="settings-action-button" onClick={() => { finish(); onReviewReminders(); }}>Review reminders</Button>}
						</div>
						{reminders?.recovery}
						{homeScreen.platform && <HomeScreenInstallInstructions platform={homeScreen.platform} />}
					</SettingsDisclosure>
					<SettingsDisclosure title="About">
						<VersionSettings />
						<Button size="touch" className="settings-action-button" disabled={unsynced || exclusive} aria-disabled={busy || unsynced} onClick={() => void run('update', appUpdate.update)}>{appUpdate.updating ? 'Updating…' : appUpdate.version ? 'Update available' : 'Update app'}</Button>
						{unsynced && <p className="settings-help">Finish syncing or review pending changes before updating.</p>}
					</SettingsDisclosure>
					<Button size="touch" variant="ghost" tone="danger" className="settings-logout-button" data-action="logout" disabled={exclusive || !ready} onClick={() => navigate('logout')}><LogOut size={16} /> Log out</Button>
				</motion.div>
				<motion.div ref={backRef} className="settings-panel settings-detail" onAnimationComplete={() => { if (page === 'settings') setSubpage(null); }} inert={page === 'settings'} aria-hidden={page === 'settings'}
					initial={false} animate={{ x: reducedMotion ? 0 : page === 'settings' ? '100%' : '0%', opacity: reducedMotion && page === 'settings' ? 0 : 1 }}
					transition={reducedMotion ? { duration: 0 } : PWA_NAVIGATION_SPRING}>
				{subpage === 'shortcut' && <div className="crate-reading settings-subpage">
					{reading?.shortcut ?? <p>{reading?.ready ? 'Connect Reading in Obsidian to set up the shortcut.' : 'Loading Reading settings…'}</p>}
				</div>}
				{subpage === 'logout' && <div className="settings-subpage">
					<p>This logs out of Reading and Reminders and clears their offline data and drafts from this device. Your synced data stays on the server.</p>
					{unsynced && <p className="settings-attention">There are unsynced or unverified changes on this device. Export and review them before logging out.</p>}
					<div className="settings-actions">{exports}</div>
					{reminders?.recovery}
					<div className="settings-actions">
						<Button size="touch" disabled={exclusive} onClick={() => navigate('settings')}>Cancel</Button>
						<Button size="touch" tone="danger" disabled={exclusive || !ready} aria-disabled={busy || !ready} onClick={() => void run('logout', async () => {
							const model = activeSection === 'reading' && reading?.connected ? reading : reminders?.connected ? reminders : reading;
							if (!model) throw new Error('Settings are still loading.');
							await model.onLogout();
						})}>{pending.has('logout') ? 'Logging out…' : 'Log out and clear device data'}</Button>
					</div>
				</div>}
				</motion.div>
			</div>
		</aside>
	</PwaModalSheet>;
}
