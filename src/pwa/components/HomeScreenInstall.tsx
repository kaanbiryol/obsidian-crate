import React from 'react';
import type { HomeScreenPlatform } from '../hooks/useHomeScreenInstall';

export function HomeScreenInstallInstructions({ platform, encrypted = false }: { platform: HomeScreenPlatform; encrypted?: boolean }) {
	return (
		<section className="settings-panel__section" aria-labelledby="settings-home-screen-title">
			<h3 id="settings-home-screen-title" className="settings-panel__title">Add to home screen</h3>
			<div className="settings-group pwa-home-screen-instructions">
				{platform === 'ios' ? (
					<ol>
						<li>Select <strong>Share</strong> → <strong>View More</strong> → <strong>Add to Home Screen</strong>.</li>
						<li>Keep <strong>Open as Web App</strong> on, then select <strong>Add</strong>.</li>
						<li>Open <strong>Crate</strong> from your Home Screen.{encrypted && <> Select <strong>Connect with Obsidian</strong> to unlock Reading and Reminders.</>}</li>
					</ol>
				) : (
					<>
						<p>Keep Crate a tap away, alongside your other apps.</p>
						<ol>
							<li>Open your browser’s <strong>menu (⋮)</strong>.</li>
							<li>Select <strong>Install app</strong> or <strong>Add to home screen</strong>, then <strong>Install</strong>.</li>
							<li>Follow the prompts, then open <strong>Crate</strong> from your home screen.</li>
						</ol>
						<p className="pwa-home-screen-instructions__hint">If the option is missing, reopen your Crate setup link in Chrome.</p>
					</>
				)}
				{platform === 'ios' && encrypted && <p className="pwa-home-screen-instructions__hint">In Obsidian, open <strong>Crate settings → Sync → Manage encryption → Connect web app</strong>. Compare the codes and confirm on both devices. Crate will remember this device.</p>}
			</div>
		</section>
	);
}
