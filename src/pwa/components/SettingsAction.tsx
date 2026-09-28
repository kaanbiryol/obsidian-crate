import { Button } from '@/ui/shared/Button';
import type { ComponentProps } from 'react';

/** Settings actions share the same full-width target as navigation rows. */
export function SettingsAction({ className, ...props }: ComponentProps<typeof Button>) {
	return <Button {...props} className={['settings-action-row', className].filter(Boolean).join(' ')} />;
}
