import type { ButtonHTMLAttributes } from 'react';

import { ThemeIcon } from '../../reminders/components/theme-icon';
import { Button } from './Button';
import type { ThemeIconSize } from '../../reminders/components/theme-icon';

type NativeButtonProps = Omit<
	ButtonHTMLAttributes<HTMLButtonElement>,
	'onClick' | 'children' | 'aria-label'
>;

interface IconButtonProps extends NativeButtonProps {
	preventFocusOnPress?: boolean;
	icon: string;
	label: string;
	onClick: () => void;
	iconSize?: ThemeIconSize;
	size?: 'small' | 'medium' | 'large';
	tone?: 'neutral' | 'danger' | 'accent';
	variant?: 'ghost' | 'surface';
}

export function IconButton({
	icon,
	label,
	onClick,
	iconSize = 'm',
	size = 'medium',
	tone = 'neutral',
	variant = 'ghost',
	className,
	title = label,
	...props
}: IconButtonProps) {
	return (
		<Button
			{...props}
			onClick={onClick}
			aria-label={label}
			title={title}
			className={['crate-icon-button', className].filter(Boolean).join(' ')}
			data-size={size}
			data-tone={tone}
			data-variant={variant}
		>
			<ThemeIcon size={iconSize} id={icon} />
		</Button>
	);
}
