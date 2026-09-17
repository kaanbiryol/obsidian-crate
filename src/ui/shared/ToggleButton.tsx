import type { ComponentProps } from 'react';
import { Toggle } from '@base-ui/react/toggle';
import { Button } from './Button';

type Props = Omit<ComponentProps<typeof Button>, 'aria-pressed' | 'onClick'> & {
    pressed: boolean;
    onPressedChange: (pressed: boolean) => void;
};

export function ToggleButton({ pressed, onPressedChange, ...props }: Props) {
    return <Toggle pressed={pressed} onPressedChange={onPressedChange} render={<Button {...props} />} />;
}
