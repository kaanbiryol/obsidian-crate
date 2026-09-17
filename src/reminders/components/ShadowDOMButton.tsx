import React, { forwardRef } from 'react';
import { Button } from '../../ui/shared/Button';

interface ButtonBehaviorProps {
	onPress: () => void;
	children: React.ReactNode;
	variant?: 'solid' | 'bordered' | 'light' | 'flat' | 'faded' | 'shadow' | 'ghost';
	color?: 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger';
	size?: 'sm' | 'md' | 'lg';
	radius?: 'none' | 'sm' | 'md' | 'lg' | 'full';
	isIconOnly?: boolean;
	isDisabled?: boolean;
	isLoading?: boolean;
	disableAnimation?: boolean;
	startContent?: React.ReactNode;
	endContent?: React.ReactNode;
}

type NativeButtonProps = Omit<
	React.ButtonHTMLAttributes<HTMLButtonElement>,
	'children' | 'color' | 'disabled' | 'onClick' | 'size'
> & ButtonBehaviorProps;

function buttonClassName(className: string | undefined): string {
	return ['shadow-dom-button', className].filter(Boolean).join(' ');
}

function buttonContent({
	children,
	isLoading,
	startContent,
	endContent,
}: Pick<ButtonBehaviorProps, 'children' | 'isLoading' | 'startContent' | 'endContent'>): React.ReactNode {
	return (
		<>
			{isLoading ? <span className="shadow-dom-button__spinner" aria-hidden="true" /> : startContent}
			{children}
			{endContent}
		</>
	);
}

function semanticAttributes(props: ButtonBehaviorProps) {
	return {
		'aria-busy': props.isLoading || undefined,
		'data-color': props.color,
		'data-icon-only': props.isIconOnly || undefined,
		'data-radius': props.radius,
		'data-size': props.size,
		'data-variant': props.variant,
	};
}

export const ShadowDOMButton = forwardRef<HTMLButtonElement, NativeButtonProps>(function ShadowDOMButton({
	onPress,
	children,
	type = 'button',
	className,
	isDisabled,
	isLoading,
	disableAnimation: _disableAnimation,
	startContent,
	endContent,
	variant,
	color,
	size,
	radius,
	isIconOnly,
	...props
}, ref) {
	const behavior = { onPress, children, isDisabled, isLoading, startContent, endContent, variant, color, size, radius, isIconOnly };

	return (
		<Button
			ref={ref} onClick={onPress}
			type={type}
			className={buttonClassName(className)}
			disabled={isDisabled || isLoading}
			{...semanticAttributes(behavior)}
			{...props}
		>
			{buttonContent(behavior)}
		</Button>
	);
});
