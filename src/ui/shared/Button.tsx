import React, { forwardRef } from 'react';
import { usePressFeedback } from './usePressFeedback';
import { Button as BaseButton } from '@base-ui/react/button';

type NativeButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
	preventFocusOnPress?: boolean;
	// Omit variant only for controls with their own presentation (tabs, rows, icons).
	variant?: 'outline' | 'primary' | 'ghost';
	tone?: 'neutral' | 'danger';
	size?: 'compact' | 'touch';
	children?: React.ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, NativeButtonProps>(function Button({
	onClick = () => {},
	preventFocusOnPress,
	onMouseDown,
	onPointerDown,
	onPointerMove, onPointerUp, onPointerCancel, onPointerLeave, onLostPointerCapture, onBlur, onKeyDown, onKeyUp, onClickCapture,
	children,
	className,
	variant,
	tone,
	size,
	style,
	type = 'button',
	...props
}, ref) {
	const { pressed, events, clearPress } = usePressFeedback<HTMLButtonElement>();
	return (
		<BaseButton
			ref={ref} onClick={event => { clearPress(); onClick(event); }} className={[variant && 'crate-action-button', className].filter(Boolean).join(' ') || undefined} data-variant={variant} data-tone={tone} data-size={size} style={style} type={type} {...props}
			data-press-active={pressed && !props.disabled ? '' : undefined}
			onMouseDown={(event) => {
				if (preventFocusOnPress) event.preventDefault();
				onMouseDown?.(event);
			}}
			onPointerDown={(event) => {
				// Touch must remain native so a press can become a scroll gesture.
				// The compatibility mousedown still prevents focus transfer on taps.
				if (preventFocusOnPress && event.pointerType !== 'touch') event.preventDefault();
				onPointerDown?.(event);
				events.onPointerDown?.(event);
			}}
			onPointerMove={event => {
				events.onPointerMove?.(event);
				onPointerMove?.(event);
			}}
			onPointerUp={event => { clearPress(); onPointerUp?.(event); }}
			onPointerCancel={event => { clearPress(); onPointerCancel?.(event); }}
			onPointerLeave={event => { clearPress(); onPointerLeave?.(event); }}
			onLostPointerCapture={event => { clearPress(); onLostPointerCapture?.(event); }}
			onKeyDown={event => { events.onKeyDown?.(event); onKeyDown?.(event); }}
			onKeyUp={event => { clearPress(); onKeyUp?.(event); }}
			onClickCapture={event => { clearPress(); onClickCapture?.(event); }}
			onBlur={event => { clearPress(); onBlur?.(event); }}
		>
			{children}
		</BaseButton>
	);
});
