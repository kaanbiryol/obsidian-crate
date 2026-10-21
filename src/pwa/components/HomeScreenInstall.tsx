import React, { useId } from 'react';
import type { HomeScreenPlatform } from '../hooks/useHomeScreenInstall';
import { SetupStep, SetupSteps } from './SetupSteps';

export function HomeScreenInstallInstructions({ platform, encrypted = false }: { platform: HomeScreenPlatform; encrypted?: boolean }) {
	const titleId = useId();
	return <section className="settings-panel__section pwa-home-screen-instructions" aria-labelledby={titleId}>
		<div className="settings-panel__heading"><h3 id={titleId} className="settings-panel__title">Add to home screen</h3></div>
		<HomeScreenInstallSteps platform={platform} encrypted={encrypted} />
	</section>;
}

export function HomeScreenInstallSteps({ platform, encrypted = false }: { platform: HomeScreenPlatform; encrypted?: boolean }) {
	return <>
		<div className="setup-steps-card">
			{platform === 'ios' ? (
				<SetupSteps>
					<SetupStep number={1}>Select <strong>Share</strong> → <strong>View More</strong> → <strong>Add to Home Screen</strong>.</SetupStep>
					<SetupStep number={2}>Keep <strong>Open as Web App</strong> on, then select <strong>Add</strong>.</SetupStep>
					<SetupStep number={3}>Open <strong>Crate</strong> from your Home Screen.{encrypted && <> Select <strong>Connect with Obsidian</strong> to unlock Reading and Reminders.</>}</SetupStep>
				</SetupSteps>
			) : (
				<SetupSteps>
					<SetupStep number={1}>Open your browser’s <strong>menu (⋮)</strong>.</SetupStep>
					<SetupStep number={2}>Select <strong>Install app</strong> or <strong>Add to home screen</strong>, then <strong>Install</strong>.</SetupStep>
					<SetupStep number={3}>Follow the prompts, then open <strong>Crate</strong> from your home screen.</SetupStep>
				</SetupSteps>
			)}
		</div>
		{platform === 'android' && <p className="setup-steps-note">If the option is missing, reopen your Crate setup link in Chrome.</p>}
		{platform === 'ios' && encrypted && <p className="setup-steps-note">In Obsidian, open <strong>Crate settings → Sync → Manage encryption → Connect web app</strong>. Compare the codes and confirm on both devices. Crate will remember this device.</p>}
	</>;
}
