import type { HTMLAttributes, ReactNode } from 'react';

type SettingsRowProps = HTMLAttributes<HTMLElement> & {
	as?: 'div' | 'label';
	title?: string;
	description?: ReactNode;
};

export function SettingsRow({ as: Root = 'div', title, description, children, className, ...props }: SettingsRowProps) {
	return <Root {...props} className={['settings-row', className].filter(Boolean).join(' ')}>
		{(title || description) && <span className="settings-row__copy">
			{title && <strong>{title}</strong>}
			{typeof description === 'string' ? <span>{description}</span> : description}
		</span>}
		{children}
	</Root>;
}
