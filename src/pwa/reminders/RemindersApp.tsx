import { PageTitleContext } from '@/reminders/ui/shared/lexical/pageTitles';
import { useCallback, useContext } from 'react';
import { useLaunchReminderModal } from './useLaunchReminderModal';
import { usePrepareReminderEditor } from './editor/usePrepareReminderEditor';
import { FeatureNavigationContext } from '../navigation/feature-navigation';
import { PwaHeaderActions, PwaLaunchSplash, PwaPullRefreshIndicator, PwaTopNotices } from '../components/PwaChrome';
import { PwaRemindersAppShell } from './PwaRemindersAppShell';
import type { ReminderCardRenderer } from '@/reminders/ui/shared/useRemindersShellModel';
import { useAppUpdate } from '../update/PwaUpdateProvider';
import { ReminderCacheNotice } from './notices/ReminderCacheNotice';
import { ReminderSourceNotice } from './notices/ReminderSourceNotice';
import { ReminderRecoveryNotices } from './notices/ReminderRecoveryNotices';
import { ReminderSyncNotice } from './notices/ReminderSyncNotice';
import { WebReminderCard } from './WebReminderCard';

// Keep the editor ready for the tap's synchronous focus/keyboard activation.
import { ReminderSheet } from './editor/ReminderSheet';

import { AppSyncIndicator } from '../sync/AppSyncIndicator';
import { useRemindersRuntime } from './RemindersRuntime';
import { usePwaPreferences } from '../settings/usePwaPreferences';

export function RemindersApp() {
	const { preferences } = usePwaPreferences();
	const active = useContext(FeatureNavigationContext)?.active !== false;
	const { connection, sync, mutations, editor, status, presentation, enablePushNotifications } = useRemindersRuntime();
	const { authToken, bootstrapped, config, selectedProject, setSelectedProject, startTab, launchReminderId, setLaunchReminderId } = connection;
	const { loading, refreshing, error, issues, dataMode, isOffline, loadReminders, rebuildOfflineCache } = sync;
	const {
		toggleReminderCompleted, persistReorder, visibleReminders, visibleProjects, changes,
		ready: mutationsReady, retryChange, discardChange, storageError, retryInitialization,
		recoveryChanges, recoverChanges, quarantinedChanges, removeQuarantinedChanges,
	} = mutations;
	const { modal, saving, transition: modalTransition, closeModal, openReminder, openModal, editFailedChange, editReminder, saveReminder, deleteReminder } = editor;
	const { readOnlyMessage, canShowNotificationPrompt, statusText } = status;
	const {
		colorScheme, isDarkMode, settingsOpen, toggleSettings, reorderDragging, setReorderDragging,
		showToast, handlePullRefresh, initialContentReady, sharedReminders, resolvePageTitle,
	} = presentation;
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

	const renderSharedCard = useCallback<ReminderCardRenderer>(({ reminder, index, hideProject }) => (
		<WebReminderCard
			listStyle={preferences.listStyle}
			colorScheme={colorScheme}
			key={`${reminder.id}-${reminder.dueDate || reminder.dueDatetime || ''}`}
			reminder={reminder}
			index={index}
			hideProject={hideProject}
			onEdit={editReminder}
			onToggleComplete={toggleReminderCompleted}
		/>
	), [editReminder, toggleReminderCompleted, preferences.listStyle, colorScheme]);

	// The shell memoizes project detail props on these, so keep them stable.
	const renderHeaderRight = useCallback((isProjectDetail: boolean) => (
		<PwaHeaderActions
			settingsOpen={settingsOpen}
			onToggleSettings={toggleSettings}
			showSettings={!isProjectDetail}
		>
			<AppSyncIndicator />
		</PwaHeaderActions>
	), [settingsOpen, toggleSettings]);
	const renderBelowHeader = useCallback((isProjectDetail: boolean) => (
		<>
			<PwaPullRefreshIndicator
				enabled={Boolean(!loading && !modal && !settingsOpen && !reorderDragging)}
				onRefresh={handlePullRefresh}
			/>
			<PwaTopNotices
				statusText={statusText}
				onRetry={isOffline ? undefined : () => { void handlePullRefresh(); }}
				retrying={refreshing}
				showNotificationPrompt={canShowNotificationPrompt && !isProjectDetail}
				onEnableNotifications={enablePushNotifications}
			>
				<ReminderSourceNotice issues={issues} refreshing={refreshing} isOffline={isOffline} onRefresh={() => { void loadReminders({ silent: true }); }} />
				<ReminderCacheNotice isOffline={isOffline} onRebuild={rebuildOfflineCache} />
				{(changes.some(change => change.status !== 'pending') || storageError) && <ReminderSyncNotice
					changes={changes}
					isOffline={isOffline}
					storageError={storageError}
					onRetryInitialization={retryInitialization}
					onRetry={retryChange}
					onEdit={editFailedChange}
					onDiscard={discardChange}
				/>}
				<ReminderRecoveryNotices recoveryChanges={recoveryChanges} quarantinedChanges={quarantinedChanges} folderPath={config.folderPath}
					onResume={recoverChanges} onRemove={removeQuarantinedChanges} />
			</PwaTopNotices>
		</>
	), [
		loading, modal, settingsOpen, reorderDragging, handlePullRefresh, statusText, isOffline, refreshing,
		canShowNotificationPrompt, enablePushNotifications, issues, loadReminders, rebuildOfflineCache, changes,
		storageError, retryInitialization, retryChange, editFailedChange, discardChange, recoveryChanges,
		quarantinedChanges, config.folderPath, recoverChanges, removeQuarantinedChanges,
	]);
	const handleAdd = useCallback((defaultProject: string) => openModal('create', undefined, defaultProject), [openModal]);

	// Resolve the launch destination first, then keep the real chrome mounted
	// while data, pending changes, and notification state finish loading.

	if (!bootstrapped || launchPending) {
		// Launch holds the splash while a found update downloads and applies.
		return <PwaLaunchSplash updating={launchPending && Boolean(updateVersion)} />;
	}

	return (
		<div
			className={`crate-reminders-ui reminders-shadow-root pwa-shadow-root ${colorScheme}${modal || settingsOpen ? ' has-open-sheet' : ''}`}
			data-ui-host="pwa"
		>
			<PwaRemindersAppShell
				listStyle={preferences.listStyle}
				initializing={!initialContentReady}
				reminders={initialContentReady ? sharedReminders : []}
				projects={initialContentReady ? visibleProjects : []}
				incomplete={issues.length > 0}
				// Without a saved copy, an empty list would read as no reminders due.
				loadError={dataMode === 'error' ? error : null}
				checkingReminders={!initialContentReady || loading || refreshing || (dataMode === 'cached' && !isOffline && !error)}
				showLoadingIndicator={!initialContentReady || (sharedReminders.length === 0 && (loading || (dataMode === 'cached' && !isOffline && !error)))}
				isDarkMode={isDarkMode}
				initialTab={selectedProject ? 'browse' : startTab}
				requestedProject={selectedProject ?? undefined}
				upcomingDays={config.upcomingDays}
				className="app-shell pwa-reminders-view"
				headerRightContent={authToken ? renderHeaderRight : undefined}
				belowHeaderContent={initialContentReady && authToken ? renderBelowHeader : undefined}
				backgroundInert={Boolean(modal) || settingsOpen}
				addBlocked={Boolean(statusText)}
				renderCard={renderSharedCard}
				onAdd={handleAdd}
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
