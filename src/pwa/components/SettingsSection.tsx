import { useId, type ReactNode } from 'react';

export function SettingsSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
	const titleId = useId();
	return <section className="settings-panel__section" aria-labelledby={titleId}>
		<div className="settings-panel__heading">
			<h3 id={titleId} className="settings-panel__title">{title}</h3>
			{action}
		</div>
		<div className="settings-group">{children}</div>
	</section>;
}
