import type { ComponentProps } from 'react';
import { IconButton as SharedIconButton } from '../../ui/shared/IconButton';
import { ThemeIconProvider } from '../../ui/shared/ThemeIcon';
import { ObsidianIcon } from '../../ui/obsidian-icon';

export function IconButton(props: ComponentProps<typeof SharedIconButton>) {
    return <ThemeIconProvider renderer={ObsidianIcon}><SharedIconButton {...props} /></ThemeIconProvider>;
}
