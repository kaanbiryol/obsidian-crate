import type { ComponentProps } from 'react';
import { ModalHeader as SharedModalHeader } from '../../ui/shared/ModalHeader';
import { ThemeIconProvider } from '../../ui/shared/ThemeIcon';
import { ObsidianIcon } from '../../ui/obsidian-icon';

export function ModalHeader(props: ComponentProps<typeof SharedModalHeader>) {
    return <ThemeIconProvider renderer={ObsidianIcon}><SharedModalHeader {...props} /></ThemeIconProvider>;
}
