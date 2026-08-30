import React, { forwardRef } from 'react';
import { useShadowDomClickBridge } from './shadowDomClickBridge';

type NativeButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children'> & {
	onClick: () => void;
	children: React.ReactNode;
};

export const ShadowDOMNativeButton = forwardRef<HTMLButtonElement, NativeButtonProps>(function ShadowDOMNativeButton({
	onClick,
	children,
	className,
	style,
	type = 'button',
	...props
}, ref) {
	const combinedRef = useShadowDomClickBridge(onClick, ref);
	return (
		<button ref={combinedRef} className={className} style={style} type={type} {...props}>
			{children}
		</button>
	);
});
