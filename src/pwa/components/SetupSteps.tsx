import type { HTMLAttributes, ReactNode } from 'react';

/** Numbered setup instructions presented as Settings rows. */
export function SetupSteps({ className, children, ...props }: HTMLAttributes<HTMLOListElement>) {
	return <ol {...props} className={['setup-steps', className].filter(Boolean).join(' ')}>{children}</ol>;
}

export function SetupStep({ number, title, children, extra }: { number: number; title?: string; children: ReactNode; extra?: ReactNode }) {
	return <li className="setup-step">
		<span className="setup-step__number" aria-hidden="true">{number}</span>
		<div className="setup-step__content">
			{title && <h3 className="setup-step__title">{title}</h3>}
			<p className={title ? 'setup-step__detail' : 'setup-step__instruction'}>{children}</p>
			{extra && <div className="setup-step__extra">{extra}</div>}
		</div>
	</li>;
}
