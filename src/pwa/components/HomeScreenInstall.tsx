import { Button as BaseButton } from '@/ui/shared/Button';
import React from 'react';
import { Smartphone } from 'lucide-react';
import { IconButton } from '@/ui/shared/IconButton';
import type { HomeScreenPlatform } from '../hooks/useHomeScreenInstall';

export function HomeScreenInstallPrompt({ onShowSteps, onDismiss }: {
	onShowSteps: () => void;
	onDismiss: () => void;
}) {
	return (
		<section className="pwa-home-screen-prompt" aria-label="Add to home screen">
			<div className="pwa-notification-prompt__icon" aria-hidden="true"><Smartphone size={18} /></div>
			<div className="pwa-home-screen-prompt__copy">
				<strong>Add to home screen</strong>
				<span>Open Crate like an app, with one tap.</span>
					<BaseButton variant="ghost" size="touch" className="pwa-home-screen-prompt__action" type="button" onClick={onShowSteps}>Show steps</BaseButton>
			</div>
				<IconButton className="pwa-home-screen-prompt__dismiss" size="large" icon="x" label="Dismiss home screen tip" onClick={onDismiss} />
		</section>
	);
}

export function HomeScreenInstallInstructions({ platform }: { platform: HomeScreenPlatform }) {
	return (
		<section className="settings-panel__section" aria-labelledby="settings-home-screen-title">
			<h3 id="settings-home-screen-title" className="settings-panel__title">Add to home screen</h3>
			<div className="settings-group pwa-home-screen-instructions">
				{platform === 'ios' ? (
					<ol>
						<li>Select <strong>Share</strong> → <strong>View More</strong> → <strong>Add to Home Screen</strong>.</li>
						<li>Keep <strong>Open as Web App</strong> on, then select <strong>Add</strong>.</li>
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
			</div>
		</section>
	);
}
