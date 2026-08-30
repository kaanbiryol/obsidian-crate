import React, { forwardRef } from 'react';
import { motion } from 'framer-motion';
import { useShadowDomClickBridge } from './shadowDomClickBridge';

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
	const combinedRef = useShadowDomClickBridge(onClick, ref);
	return (
		<motion.button ref={combinedRef} className={className} style={style} type={type} {...props}>
			{children}
		</motion.button>
	);
});
