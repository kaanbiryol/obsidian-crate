import type { ReactNode } from 'react';

export function SettingsDisclosure({ title, children }: { title: string; children: ReactNode }) {
	return <details className="crate-settings-disclosure crate-settings-disclosure--inline">
		<summary><span>{title}</span></summary>
		<div>{children}</div>
	</details>;
}
