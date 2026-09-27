import React, { forwardRef } from 'react';
import { Button } from '../../ui/shared/Button';

export const PwaButton = forwardRef<HTMLButtonElement, React.ComponentPropsWithoutRef<typeof Button>>(function PwaButton({
	variant = 'outline',
	...props
}, ref) {
	return <Button ref={ref} {...props} variant={variant} />;
});
