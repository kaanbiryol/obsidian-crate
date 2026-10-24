import type { ThemeIconProps, ThemeIconSize } from '@/ui/shared/ThemeIcon';
import { TablerIcon } from '@/ui/shared/icons/TablerIcon';
import { TABLER_ICONS } from '@/ui/shared/icons/tabler-icons.generated';

const ICON_SIZES: Record<ThemeIconSize, number> = {
  xs: 14,
  s: 16,
  m: 18,
  l: 20,
  xl: 32,
};

export function PwaThemeIcon({ id, size, className, ...rest }: ThemeIconProps) {
  if (!TABLER_ICONS[id]) {
    return <span className={className} data-icon={id} data-icon-size={size} {...rest} />;
  }

  return (
    <TablerIcon
      name={id}
      className={className}
      data-icon={id}
      data-icon-size={size}
      size={ICON_SIZES[size]}
      {...rest}
    />
  );
}
