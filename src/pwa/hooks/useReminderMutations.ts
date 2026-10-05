import type { ConfirmedReminderSnapshot } from './useReminderSync';
import { useMemo, useRef, useState } from 'react';
import { capturePwaSession } from '../session-generation';
import { newReminderOperationId } from '../reminder-operation-id';
import { applyReminderChanges, predictReminderCompletion } from '../reminder-optimistic-state';
import type { PendingReminderChange } from '../reminder-outbox-types';
import { useReminderOutbox } from './useReminderOutbox';
import type { ApiFetch, LoadReminders, ModalState, ReminderRecord, ShowToast, StoredConfig } from '../types';

export function useReminderMutations(options: {
	enabled?: boolean;
	apiFetch: ApiFetch;
	authToken: string | null;
	bootstrapped: boolean;
	beginLocalMutation: () => () => void;
	commitReminderState: (reminders: ReminderRecord[], projects?: string[]) => void | Promise<void>;
	config: StoredConfig;
	ensureCanMutate: () => boolean;
	reminders: ReminderRecord[];
	projects: string[];
	getSnapshot: () => ConfirmedReminderSnapshot;
	selectedProject: string | null;
	refreshPresentation: () => void;
	showToast: ShowToast;
	loadReminders: LoadReminders;
	hasSnapshot?: boolean;
	canRecover?: boolean;
}) {
	const { changes, ready, outboxRef, storageError, retryInitialization, recoveryChanges, recoverChanges, quarantinedChanges, removeQuarantinedChanges } = useReminderOutbox({ ...options, folderPath: options.config.folderPath });
	const { config, ensureCanMutate, projects, getSnapshot, selectedProject, refreshPresentation, showToast } = options;
	const preparingRef = useRef(false);
	const pendingPreparations = useRef(0);
	const [, setPreparationCount] = useState(0);
	const beginPreparation = () => {
		pendingPreparations.current += 1;
		setPreparationCount(pendingPreparations.current);
		return () => {
			pendingPreparations.current -= 1;
			setPreparationCount(pendingPreparations.current);
		};
	};
	const report = (error: unknown) => showToast('error', error instanceof Error ? error.message : String(error));
	const enqueue = (change: PendingReminderChange) => {
		if (!ready || !outboxRef.current) throw new Error('Pending changes are still loading. Reopen Crate if this continues.');
		outboxRef.current.enqueue(change);
		void outboxRef.current.drain();
	};

	const saveReminder = async (modal: ModalState): Promise<boolean> => {
		if (!ensureCanMutate() || preparingRef.current) return false;
		const sessionCurrent = capturePwaSession();
		preparingRef.current = true;
		const finishPreparation = beginPreparation();
		try {
			const { createSaveReminderChange } = await import('../save-reminder-command');
			if (!sessionCurrent()) return false;
			const previous = getSnapshot().reminders.find(item => item.id === modal.reminderId);
			const change = await createSaveReminderChange(modal, config, projects, selectedProject, previous);
			if (!sessionCurrent()) return false;
			enqueue(change);
			return true;
		} catch (error) { if (sessionCurrent()) report(error); return false; }
		finally { preparingRef.current = false; finishPreparation(); }
	};

	const recordChange = async (id: string, kind: 'delete' | 'complete', extra: Record<string, unknown>, optimistic?: ReminderRecord, expectedRevision?: string, filePath?: string): Promise<PendingReminderChange> => {
		const previous = getSnapshot().reminders.find(item => item.id === id);
		if (!previous) throw new Error('Refresh reminders before changing this reminder.');
		const operationId = await newReminderOperationId();
		const change = {
			operationId, recordId: id, previous, optimistic,
			body: JSON.stringify({ folderPath: config.folderPath, id, operationId,
				filePath: filePath ?? previous.filePath, expectedRevision: expectedRevision ?? previous.revision, ...extra }),
			status: 'pending' as const, attempts: 0, retryAt: 0,
		};
		return kind === 'delete'
			? { ...change, kind, path: '/reminders/delete', method: 'DELETE' }
			: { ...change, kind, path: '/reminders/set-completed', method: 'POST' };
	};
	const toggleReminderCompleted = async (id: string, completed: boolean) => {
		if (!ensureCanMutate()) return;
		const current = capturePwaSession();
		const finishPreparation = beginPreparation();
		try {
			const previous = getSnapshot().reminders.find(item => item.id === id);
			if (!previous) throw new Error('Refresh reminders before changing this reminder.');
			const change = await recordChange(id, 'complete', { completed: !completed }, predictReminderCompletion(previous, !completed));
			if (current()) {
				enqueue(change);
				showToast('success', completed ? 'Reminder reopened' : 'Reminder completed');
			}
		} catch (error) { if (current()) report(error); }
		finally { finishPreparation(); }
	};
	const deleteReminder = async (id: string, expectedRevision?: string, filePath?: string): Promise<boolean> => {
		if (!ensureCanMutate()) return false;
		const current = capturePwaSession();
		const finishPreparation = beginPreparation();
		try {
			const change = await recordChange(id, 'delete', {}, undefined, expectedRevision, filePath);
			if (!current()) return false;
			enqueue(change);
			showToast('success', 'Reminder deleted');
			return true;
		} catch (error) { if (current()) report(error); return false; }
		finally { finishPreparation(); }
	};
	const persistReorder = async (project: string, orderedIds: string[]) => {
		if (!ensureCanMutate()) { refreshPresentation(); return; }
		const current = capturePwaSession();
		const finishPreparation = beginPreparation();
		try {
			const operationId = await newReminderOperationId();
			if (!current()) return;
			enqueue({
				operationId, kind: 'reorder', project, orderedIds: [...orderedIds], path: '/reminders/reorder', method: 'POST',
				body: JSON.stringify({ folderPath: config.folderPath, project, orderedIds,
					expectedOrder: getSnapshot().reminders.filter(item => item.project === project).map(item => item.id), operationId }),
				status: 'pending', attempts: 0, retryAt: 0,
			});
		} catch (error) { if (current()) { refreshPresentation(); report(error); } }
		finally { finishPreparation(); }
	};
	const retryChange = (operationId: string) => {
		try { outboxRef.current?.retry(operationId); void outboxRef.current?.drain(); }
		catch (error) { report(error); }
	};
	const discardChange = (operationId: string, reviewedChange?: string) => {
		try { void Promise.resolve(outboxRef.current?.discard(operationId, reviewedChange)).catch(report); }
		catch (error) { report(error); }
	};
	const prepareEdit = (operationId: string): ModalState | null => {
		const change = changes.find(item => item.operationId === operationId && item.status === 'failed' && !item.ambiguous && item.kind === 'save');
		if (!change?.modal) return null;
		const modal = JSON.parse(JSON.stringify(change.modal)) as ModalState;
		const current = getSnapshot().reminders.find(item => item.id === change.recordId);
		if (modal.mode === 'edit' && !current) {
			modal.mode = 'create';
			delete modal.reminderId;
			showToast('info', 'The original reminder was deleted. Save your draft as a new reminder.');
		}
		modal.expectedRevision = current?.revision;
		modal.filePath = current?.filePath;
		modal.recovery = true;
		return modal;
	};
	const visible = useMemo(() => applyReminderChanges(options.reminders, projects, changes), [options.reminders, projects, changes]);
	return { isPreparingMutation: () => preparingRef.current || pendingPreparations.current > 0, saveReminder, toggleReminderCompleted, deleteReminder, persistReorder, ...visible, changes, ready, retryChange, discardChange, prepareEdit, storageError, retryInitialization, recoveryChanges, recoverChanges, quarantinedChanges, removeQuarantinedChanges };
}
