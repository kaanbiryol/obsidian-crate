import { PwaButton } from './PwaButton';
import { PwaNotice } from './PwaNotice';
import React, { Component, Suspense } from 'react';

/** Failed optional asset loads must leave the app and retained intent usable. */
export class DeferredNotice extends Component<{ children: React.ReactNode }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() { return { failed: true }; }
	render() {
		if (this.state.failed) return <PwaNotice title="Recovery controls could not be loaded" role="alert"
			actions={<PwaButton variant="ghost" size="touch" onClick={() => window.location.reload()}>Reload app</PwaButton>}>
			<span>Saved changes remain on this device. Reconnect and reload to review them.</span>
		</PwaNotice>;
		return <Suspense fallback={<p role="status">Loading saved changes…</p>}>{this.props.children}</Suspense>;
	}
}
