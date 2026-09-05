import type { ComponentProps } from 'react';
import { ModalHeader as SharedModalHeader } from '../../ui/shared/ModalHeader';
import { ThemeIconProvider } from './theme-icon';
import { ObsidianIcon } from './obsidian-icon';

export function ModalHeader(props: ComponentProps<typeof SharedModalHeader>) {
    return <ThemeIconProvider renderer={ObsidianIcon}><SharedModalHeader {...props} /></ThemeIconProvider>;
}
