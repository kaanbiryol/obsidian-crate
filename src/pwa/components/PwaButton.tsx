import React, { forwardRef } from 'react';
import { Button } from '../../ui/shared/Button';

type PwaButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
	isDisabled?: boolean;
	isIconOnly?: boolean;
	preventFocusOnPress?: boolean;
	endContent?: React.ReactNode;
	variant?: React.ComponentProps<typeof Button>['variant'];
	tone?: React.ComponentProps<typeof Button>['tone'];
	size?: React.ComponentProps<typeof Button>['size'];
	onPress?: () => void;
};

export const PwaButton = forwardRef<HTMLButtonElement, PwaButtonProps>(function PwaButton({
	children,
	disabled,
	endContent,
	isDisabled,
	isIconOnly: _isIconOnly,
	preventFocusOnPress,
	variant = 'outline',
	onClick,
	onMouseDown,
	onPress,
	...props
}, ref) {
	return (
		<Button
			ref={ref}
			{...props}
			variant={variant}
			preventFocusOnPress={preventFocusOnPress}
			disabled={disabled || isDisabled}
			onMouseDown={onMouseDown}
			onClick={(event) => {
				onClick?.(event);
				if (!event.defaultPrevented) onPress?.();
			}}
		>
			{children}
			{endContent}
		</Button>
	);
});
