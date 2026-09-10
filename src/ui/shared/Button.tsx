import React, { forwardRef } from 'react';
import { useShadowDomClickBridge } from '../../reminders/components/shadowDomClickBridge';

type NativeButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children'> & {
	onClick?: () => void;
	preventFocusOnPress?: boolean;
	children: React.ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, NativeButtonProps>(function Button({
	onClick = () => {},
	preventFocusOnPress,
	onMouseDown,
	onPointerDown,
	children,
	className,
	style,
	type = 'button',
	...props
}, ref) {
	const combinedRef = useShadowDomClickBridge(onClick, ref);
	return (
		<button
			ref={combinedRef} className={className} style={style} type={type} {...props}
			onMouseDown={(event) => {
				if (preventFocusOnPress) event.preventDefault();
				onMouseDown?.(event);
			}}
			onPointerDown={(event) => {
				// Touch must remain native so a press can become a scroll gesture.
				// The compatibility mousedown still prevents focus transfer on taps.
				if (preventFocusOnPress && event.pointerType !== 'touch') event.preventDefault();
				onPointerDown?.(event);
			}}
		>
			{children}
		</button>
	);
});
