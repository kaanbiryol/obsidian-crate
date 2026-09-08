import React, { Component, Suspense } from 'react';

/** Failed optional asset loads must leave the app and retained intent usable. */
export class DeferredNotice extends Component<{ children: React.ReactNode }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() { return { failed: true }; }
	render() {
		if (this.state.failed) return <section className="pwa-reminder-sync-error" role="alert">
			<div className="pwa-reminder-sync-error__copy"><strong>Recovery controls could not be loaded</strong><span>Saved changes remain on this device. Reconnect and reload to review them.</span></div>
			<div className="pwa-reminder-sync-error__actions"><button type="button" onClick={() => window.location.reload()}>Reload app</button></div>
		</section>;
		return <Suspense fallback={<p role="status">Loading saved changes…</p>}>{this.props.children}</Suspense>;
	}
}
