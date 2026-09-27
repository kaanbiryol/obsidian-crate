import type { HTMLAttributes, ReactNode } from 'react';

/** Presentation only: features retain announcement, recovery, and action rules. */
export function PwaNotice({ title, children, actions, className, ...props }: HTMLAttributes<HTMLElement> & {
	title: string;
	actions?: ReactNode;
}) {
	return <section {...props} className={['pwa-notice', className].filter(Boolean).join(' ')}>
		<div className="pwa-notice__copy"><strong>{title}</strong>{children}</div>
		{actions && <div className="pwa-notice__actions">{actions}</div>}
	</section>;
}
