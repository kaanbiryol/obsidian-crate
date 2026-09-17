import React, { forwardRef } from 'react';
import { motion } from 'motion/react';
import { Button } from '../../ui/shared/Button';

const MotionButton = motion.create(Button);

type NativeMotionButtonProps = Omit<React.ComponentProps<typeof motion.button>, 'children' | 'onClick' | 'ref'> & {
	onClick: () => void;
	children: React.ReactNode;
};

export const ShadowDOMNativeMotionButton = forwardRef<HTMLButtonElement, NativeMotionButtonProps>(function ShadowDOMNativeMotionButton({
	onClick,
	children,
	className,
	style,
	type = 'button',
	...props
}, ref) {
	return (
		<MotionButton ref={ref} onClick={onClick} className={className} style={style} type={type} {...props}>
			{children}
		</MotionButton>
	);
});
