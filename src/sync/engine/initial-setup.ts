import type { LocalManifest } from '../manifest/manifest';
import type { SyncWork } from '../types';
import type { InitialImportApi } from '../worker-api/initial-import';

interface InitialSetupContext {
	manifest: Pick<LocalManifest, 'getInitialConfigPull' | 'setInitialConfigPull' | 'hasFile' | 'save'>;
	lastSeq: number;
	initialImport?: Pick<InitialImportApi, 'isPreparingReminders' | 'finishReminderSetup'>;
	prepareReminderScope?: () => Promise<void>;
	reportWork: (work: SyncWork) => void;
	throwIfDestroyed: () => void;
}

/** Finish local setup before waiting for server-side reminder readiness. */
export async function finishInitialSetup({ manifest, lastSeq, initialImport, prepareReminderScope, reportWork, throwIfDestroyed }: InitialSetupContext): Promise<void> {
	const initialConfig = manifest.getInitialConfigPull();
	if (initialConfig && (lastSeq > 0 || Object.keys(initialConfig.files).every(path => manifest.hasFile(path)))) {
		manifest.setInitialConfigPull(undefined);
		await manifest.save();
		throwIfDestroyed();
	}
	if (!initialImport?.isPreparingReminders()) return;
	reportWork({ phase: 'reminders' });
	await prepareReminderScope?.();
	throwIfDestroyed();
	await initialImport.finishReminderSetup(throwIfDestroyed, reminderSetup => {
		reportWork({ phase: 'reminders', reminderSetup });
	});
}
