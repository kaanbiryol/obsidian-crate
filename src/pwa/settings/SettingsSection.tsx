import { useId, type HTMLAttributes, type ReactNode } from 'react';

export function SettingsSection({ title, action, description, groupProps, children }: { title: string; action?: ReactNode; description?: string; groupProps?: HTMLAttributes<HTMLDivElement>; children: ReactNode }) {
	const titleId = useId();
	return <section className="settings-panel__section" aria-labelledby={titleId}>
		<div className="settings-panel__heading">
			<h3 id={titleId} className="settings-panel__title">{title}</h3>
			{action}
		</div>
		{description && <p className="settings-section-description">{description}</p>}
		<div {...groupProps} className={['settings-group', groupProps?.className].filter(Boolean).join(' ')}>{children}</div>
	</section>;
}
