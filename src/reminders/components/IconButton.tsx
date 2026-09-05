import type { ComponentProps } from 'react';
import { IconButton as SharedIconButton } from '../../ui/shared/IconButton';
import { ThemeIconProvider } from './theme-icon';
import { ObsidianIcon } from './obsidian-icon';

export function IconButton(props: ComponentProps<typeof SharedIconButton>) {
    return <ThemeIconProvider renderer={ObsidianIcon}><SharedIconButton {...props} /></ThemeIconProvider>;
}
