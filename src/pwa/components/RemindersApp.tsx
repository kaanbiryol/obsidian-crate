import { PageTitleContext } from '@/reminders/components/lexical/pageTitles';
import { lazy, useCallback, useContext } from 'react';
import { useLaunchReminderModal } from '../hooks/useLaunchReminderModal';
import { usePrepareReminderEditor } from '../hooks/usePrepareReminderEditor';
import { DeferredNotice } from './DeferredNotice';
import { FeatureNavigationContext } from './FeatureSwitcherButton';
import { HomeScreenInstallPrompt } from './HomeScreenInstall';
import { PwaHeaderActions, PwaLaunchSplash, PwaPullRefreshIndicator, PwaTopNotices } from './PwaChrome';
import {
	PwaRemindersAppShell,
	type PwaReminderCardRenderer,
} from './PwaRemindersAppShell';
import { useAppUpdate } from './PwaUpdateProvider';
import { ReminderCacheNotice } from './ReminderCacheNotice';
import { ReminderSourceNotice } from './ReminderSourceNotice';
import { WebReminderCard } from './WebReminderCard';

// Keep the editor ready for the tap's synchronous focus/keyboard activation.
import { ReminderSheet } from './ReminderSheet';
const ReminderSyncNotice = lazy(() => import('./ReminderSyncNotice')
	.then(module => ({ default: module.ReminderSyncNotice })));
const ReminderRecoveryNotice = lazy(() => import('./ReminderRecoveryNotice')
	.then(module => ({ default: module.ReminderRecoveryNotice })));
const ReminderQuarantineNotice = lazy(() => import('./ReminderQuarantineNotice')
	.then(module => ({ default: module.ReminderQuarantineNotice })));

import { AppSyncIndicator } from '../sync/AppSyncIndicator';
import { useRemindersRuntime } from './RemindersRuntime';
import { usePwaPreferences } from '../hooks/usePwaPreferences';

export function RemindersApp() {
	const { preferences } = usePwaPreferences();
	const active = useContext(FeatureNavigationContext)?.active !== false;
	const {
		encryption, colorScheme, isDarkMode, authToken, bootstrapped, config, selectedProject,
		setSelectedProject, startTab, settingsOpen, launchReminderId, setLaunchReminderId, modal,
		saving, modalTransition, closeModal, openReminder, reorderDragging, setReorderDragging,
		showToast, homeScreenInstall, loading, refreshing, error,
		issues, dataMode, isOffline, loadReminders, rebuildOfflineCache, enablePushNotifications,
		readOnlyMessage, readOnly, canShowNotificationPrompt, statusText, statusKind, handlePullRefresh,
		toggleSettings, saveReminder, toggleReminderCompleted, deleteReminder, persistReorder, visibleReminders,
		visibleProjects, changes, mutationsReady, retryChange, discardChange, storageError,
		retryInitialization, recoveryChanges, recoverChanges, quarantinedChanges, removeQuarantinedChanges, initialContentReady,
		openModal, editFailedChange, sharedReminders, editReminder, resolvePageTitle,
	} = useRemindersRuntime();
	const { version: updateVersion, launchPending } = useAppUpdate();

	const launchChange = changes.find(change => launchReminderId && (change.recordId === launchReminderId || change.optimistic?.id === launchReminderId));
	usePrepareReminderEditor(initialContentReady && !launchPending && Boolean(authToken)
		&& !modal && !settingsOpen && !launchReminderId);
	useLaunchReminderModal({
		authToken,
		bootstrapped,
		dataMode,
		isOffline,
		launchReminderId,
		loading: loading || !mutationsReady,
		readOnlyMessage: readOnlyMessage || (launchChange
			? 'Use the sync notice to finish this reminder’s pending change before editing.' : null),
		refreshing,
		reminders: visibleReminders,
		selectedProject,
		setLaunchReminderId,
		openReminder,
		setSelectedProject,
		showToast,
	});

	const renderSharedCard = useCallback<PwaReminderCardRenderer>(({ reminder, index, hideProject }) => (
		<WebReminderCard
			listStyle={preferences.reminderListStyle}
			key={`${reminder.id}-${reminder.dueDate || reminder.dueDatetime || ''}`}
			reminder={reminder}
			index={index}
			hideProject={hideProject}
			onEdit={editReminder}
			onToggleComplete={toggleReminderCompleted}
		/>
	), [editReminder, toggleReminderCompleted, preferences.reminderListStyle]);

	// Resolve the launch destination first, then keep the real chrome mounted
	// while data, pending changes, and notification state finish loading.

	if (!bootstrapped || launchPending) {
		return <PwaLaunchSplash updating={launchPending && Boolean(updateVersion)} />;
	}

	return (
		<div
			className={`crate-reminders-ui reminders-shadow-root pwa-shadow-root ${colorScheme}${modal || settingsOpen ? ' has-open-sheet' : ''}`}
			data-ui-host="pwa"
		>
			<PwaRemindersAppShell
				listStyle={preferences.reminderListStyle}
				key={`pwa-shell-${selectedProject ?? startTab}`}
				initializing={!initialContentReady}
				reminders={initialContentReady ? sharedReminders : []}
				projects={initialContentReady ? visibleProjects : []}
				incomplete={issues.length > 0}
				checkingReminders={!initialContentReady || loading || refreshing || (dataMode === 'cached' && !isOffline && !error)}
				showLoadingIndicator={!initialContentReady || (sharedReminders.length === 0 && (loading || (dataMode === 'cached' && !isOffline && !error)))}
				isDarkMode={isDarkMode}
				initialTab={selectedProject ? 'browse' : startTab}
				initialProject={selectedProject ?? undefined}
				upcomingDays={config.upcomingDays}
				className="app-shell pwa-reminders-view"
				headerRightContent={authToken ? (isProjectDetail) => (
					<PwaHeaderActions
						settingsOpen={settingsOpen}
						onToggleSettings={toggleSettings}
						showSettings={!isProjectDetail}
					>
						<AppSyncIndicator />
					</PwaHeaderActions>
				) : undefined}

				belowHeaderContent={initialContentReady && authToken ? (isProjectDetail) => (
					<>
						<PwaPullRefreshIndicator
							enabled={Boolean(!loading && !modal && !settingsOpen && !reorderDragging)}
							onRefresh={handlePullRefresh}
						/>
						<PwaTopNotices
							statusText={statusText}
							statusKind={statusKind}
							showNotificationPrompt={canShowNotificationPrompt && !isProjectDetail}
							onEnableNotifications={enablePushNotifications}
						>
							<ReminderSourceNotice issues={issues} refreshing={refreshing} isOffline={isOffline} onRefresh={() => { void loadReminders({ silent: true }); }} />
							<ReminderCacheNotice isOffline={isOffline} onRebuild={rebuildOfflineCache} />
							{(changes.some(change => change.status !== 'pending') || storageError) && <DeferredNotice><ReminderSyncNotice
								changes={changes}
								isOffline={isOffline}
								storageError={storageError}
								onRetryInitialization={retryInitialization}
								onRetry={retryChange}
								onEdit={editFailedChange}
								onDiscard={discardChange}
							/></DeferredNotice>}
							{recoveryChanges.length > 0 && <DeferredNotice><ReminderRecoveryNotice changes={recoveryChanges} folderPath={config.folderPath} onResume={recoverChanges} /></DeferredNotice>}
							{quarantinedChanges.length > 0 && <DeferredNotice><ReminderQuarantineNotice entries={quarantinedChanges} folderPath={config.folderPath} onRemove={removeQuarantinedChanges} /></DeferredNotice>}
							{homeScreenInstall.showPrompt && !isProjectDetail && (
								<HomeScreenInstallPrompt encrypted={encryption.status === 'ready'} platform={homeScreenInstall.platform} onShowSteps={toggleSettings} onDismiss={homeScreenInstall.dismiss} />
							)}
						</PwaTopNotices>
					</>
				) : undefined}
				suppressFab={readOnly || !mutationsReady}
				backgroundInert={Boolean(modal) || settingsOpen}
				renderCard={renderSharedCard}
				onAdd={(defaultProject) => openModal('create', undefined, defaultProject)}
				onReorder={persistReorder}
				onReorderDragActiveChange={setReorderDragging}
			>
				{modal && active && !settingsOpen && (
					<PageTitleContext.Provider value={resolvePageTitle}>
						<ReminderSheet
							key={`${modal.mode}-${modal.reminderId ?? 'new'}-${modal.operationId ?? ''}`}
							colorScheme={colorScheme}
							modal={modal}
							folderPath={config.folderPath}
							projects={visibleProjects}
							saving={saving}
							isClosing={modalTransition.isClosing}
							onClose={closeModal}
							onClosed={modalTransition.finishClose}
							onSave={saveReminder}
							onDelete={deleteReminder}
						/>
					</PageTitleContext.Provider>
				)}
			</PwaRemindersAppShell>
		</div>
	);
}
