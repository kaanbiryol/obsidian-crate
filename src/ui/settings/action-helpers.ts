import { Notice, Setting, type ButtonComponent } from 'obsidian';
import { errorMessage } from '../../plugin/logger';

interface RunButtonTaskContext {
	setButtonText: (text: string) => void;
	setProgress: (message: string) => void;
}

export interface RunButtonTaskOptions<T> {
	button: ButtonComponent;
	idleText: string;
	runningText: string;
	progressEl?: HTMLElement;
	progressMessage?: string;
	task: (context: RunButtonTaskContext) => Promise<T>;
	onStart?: () => void | Promise<void>;
	onSuccess?: (result: T) => void | Promise<void>;
	onError?: (error: unknown) => void | Promise<void>;
	errorNoticePrefix?: string;
	onFinally?: () => void | Promise<void>;
}

export function getErrorMessage(error: unknown): string {
	return errorMessage(error);
}

export async function runButtonTask<T>(options: RunButtonTaskOptions<T>): Promise<void> {
	const {
		button,
		idleText,
		runningText,
		progressEl,
		progressMessage,
		task,
		onStart,
		onSuccess,
		onError,
		errorNoticePrefix,
		onFinally,
	} = options;

	button.setDisabled(true);
	button.setButtonText(runningText);

	if (progressEl) {
		progressEl.show();
		if (progressMessage) {
			progressEl.textContent = progressMessage;
		}
	}

	const context: RunButtonTaskContext = {
		setButtonText: (text: string) => {
			button.setButtonText(text);
		},
		setProgress: (message: string) => {
			if (progressEl) {
				progressEl.textContent = message;
			}
		},
	};

	try {
		if (onStart) {
			await onStart();
		}
		const result = await task(context);
		if (onSuccess) {
			await onSuccess(result);
		}
	} catch (error) {
		if (onError) {
			await onError(error);
		} else if (errorNoticePrefix) {
			new Notice(`${errorNoticePrefix}: ${getErrorMessage(error)}`);
		}
	} finally {
		button.setDisabled(false);
		button.setButtonText(idleText);
		if (progressEl) {
			progressEl.hide();
		}
		if (onFinally) {
			await onFinally();
		}
	}
}

export interface FileSyncProgress {
	container: HTMLElement;
	label: HTMLElement;
	fill: HTMLElement;
}

export function createFileSyncProgress(setting: Setting): FileSyncProgress {
	const container = setting.settingEl.createDiv({ cls: 'crate-sync-progress' });
	container.hide();
	const label = container.createDiv({ cls: 'crate-sync-progress-label' });
	const progressBar = container.createDiv({ cls: 'crate-sync-progress-bar' });
	const fill = progressBar.createDiv({ cls: 'crate-sync-progress-fill' });

	return { container, label, fill };
}

export function showFileSyncProgress(progress: FileSyncProgress): void {
	progress.container.show();
	progress.fill.setCssProps({ width: '0%' });
	progress.label.textContent = '';
}

export function updateFileSyncProgress(progress: FileSyncProgress, current: number, total: number): void {
	const safeTotal = total > 0 ? total : 1;
	const pct = Math.round((current / safeTotal) * 100);
	progress.fill.setCssProps({ width: `${Math.min(Math.max(pct, 0), 100)}%` });
	progress.label.textContent = `${current} / ${total} files`;
}

export function hideFileSyncProgress(progress: FileSyncProgress): void {
	progress.container.hide();
	progress.fill.setCssProps({ width: '0%' });
	progress.label.textContent = '';
}
