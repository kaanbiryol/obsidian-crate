import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	FakeElement,
	MockSetting,
	createObsidianUiModule,
	resetObsidianUiMocks,
} from '../../test/fakes/obsidian-ui';

afterEach(() => {
	resetObsidianUiMocks();
	vi.resetModules();
	vi.doUnmock('obsidian');
});

describe('runButtonTask', () => {
	it('shows progress while running and restores the idle button state', async () => {
		vi.doMock('obsidian', () => createObsidianUiModule());
		const { runButtonTask } = await import('./action-helpers');

		const progressEl = new FakeElement('p');
		progressEl.hide();

		const button = {
			disabled: false,
			text: '',
			setDisabled(value: boolean) {
				this.disabled = value;
				return this;
			},
			setButtonText(value: string) {
				this.text = value;
				return this;
			},
		};

		await runButtonTask({
			button: button as never,
			idleText: 'Sync now',
			runningText: 'Syncing...',
			progressEl: progressEl as never,
			progressMessage: 'Starting sync...',
			task: async ({ setButtonText, setProgress }) => {
				expect(button.disabled).toBe(true);
				expect(button.text).toBe('Syncing...');
				expect(progressEl.style.display).toBe('');
				expect(progressEl.textContent).toBe('Starting sync...');

				setButtonText('Uploading...');
				setProgress('Uploading files...');
				return 3;
			},
		});

		expect(button.disabled).toBe(false);
		expect(button.text).toBe('Sync now');
		expect(progressEl.style.display).toBe('none');
		expect(progressEl.textContent).toBe('Uploading files...');
	});
});

describe('file sync progress helpers', () => {
	it('updates visibility and width through helper APIs', async () => {
		vi.doMock('obsidian', () => createObsidianUiModule());
		const {
			createFileSyncProgress,
			hideFileSyncProgress,
			showFileSyncProgress,
			updateFileSyncProgress,
		} = await import('./action-helpers');

		const containerEl = new FakeElement('div');
		const setting = new MockSetting(containerEl);
		const progress = createFileSyncProgress(setting as never);

		expect(progress.container.style.display).toBe('none');

		showFileSyncProgress(progress);
		expect(progress.container.style.display).toBe('');
		expect(progress.fill.style.getPropertyValue('width')).toBe('0%');

		updateFileSyncProgress(progress, 2, 5);
		expect(progress.label.textContent).toBe('2 / 5 files');
		expect(progress.fill.style.getPropertyValue('width')).toBe('40%');

		hideFileSyncProgress(progress);
		expect(progress.container.style.display).toBe('none');
		expect(progress.fill.style.getPropertyValue('width')).toBe('0%');
		expect(progress.label.textContent).toBe('');
	});
});
