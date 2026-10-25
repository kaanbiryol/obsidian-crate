import { Button } from '@/ui/shared/Button';
import type { LucideIcon } from 'lucide-react';
import type { ComponentProps } from 'react';

/** Settings actions share the same full-width target as navigation rows, with an optional trailing icon. */
export function SettingsAction({ className, icon: Icon, children, ...props }: ComponentProps<typeof Button> & { icon?: LucideIcon }) {
	return <Button {...props} className={['settings-action-row', className].filter(Boolean).join(' ')}>
		{Icon ? <><span>{children}</span><Icon size={17} aria-hidden="true" /></> : children}
	</Button>;
}
