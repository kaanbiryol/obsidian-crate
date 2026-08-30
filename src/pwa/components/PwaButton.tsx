import React, { forwardRef } from 'react';

type PwaButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
	isDisabled?: boolean;
	isIconOnly?: boolean;
	preventFocusOnPress?: boolean;
	endContent?: React.ReactNode;
	variant?: string;
	onPress?: () => void;
};

export const PwaButton = forwardRef<HTMLButtonElement, PwaButtonProps>(function PwaButton({
	children,
	disabled,
	endContent,
	isDisabled,
	isIconOnly: _isIconOnly,
	preventFocusOnPress,
	variant: _variant,
	onClick,
	onMouseDown,
	onPress,
	...props
}, ref) {
	return (
		<button
			ref={ref}
			{...props}
			disabled={disabled || isDisabled}
			onMouseDown={(event) => {
				if (preventFocusOnPress) event.preventDefault();
				onMouseDown?.(event);
			}}
			onClick={(event) => {
				onClick?.(event);
				if (!event.defaultPrevented) onPress?.();
			}}
		>
			{children}
			{endContent}
		</button>
	);
});
