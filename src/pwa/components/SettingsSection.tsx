import { useId, type ReactNode } from 'react';

export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
	const titleId = useId();
	return <section className="settings-panel__section" aria-labelledby={titleId}>
		<h3 id={titleId} className="settings-panel__title">{title}</h3>
		<div className="settings-group">{children}</div>
	</section>;
}
