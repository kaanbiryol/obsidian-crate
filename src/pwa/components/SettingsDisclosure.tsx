import type { ReactNode } from 'react';
import { Collapsible } from '@base-ui/react/collapsible';
import { ChevronRight } from 'lucide-react';

export function SettingsDisclosure({ title, summary, children, open, onOpenChange }: {
	title: string;
	summary?: string;
	children: ReactNode;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	return <Collapsible.Root className="settings-disclosure" open={open} onOpenChange={onOpenChange}>
		<Collapsible.Trigger className="settings-disclosure__trigger">
			<span>{title}</span><span className="settings-disclosure__summary">{summary}<ChevronRight size={16} aria-hidden="true" /></span>
		</Collapsible.Trigger>
		<Collapsible.Panel className="settings-disclosure__panel">{children}</Collapsible.Panel>
	</Collapsible.Root>;
}
