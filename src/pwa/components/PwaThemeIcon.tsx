import {
  Calendar,
  CalendarPlus,
  Sun,
  Sunrise,
  Sunset,
  Minus,
  CalendarCheck,
  CalendarRange,
  Check,
  ChevronDown,
  ChevronLeft,
  Circle,
  CircleCheck,
  Clock,
  Eye,
  EyeOff,
  Flag,
  FolderOpen,
  Trash2,
  X,
  GripVertical,
  Hash,
  Inbox,
  Plus,
  Repeat,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';

import type { ThemeIconProps, ThemeIconSize } from '@/reminders/components/theme-icon';

const ICONS: Record<string, LucideIcon> = {
  folder: FolderOpen,
  'trash-2': Trash2,
  x: X,
  calendar: Calendar,
  'calendar-plus': CalendarPlus,
  sun: Sun,
  sunrise: Sunrise,
  sunset: Sunset,
  minus: Minus,
  'calendar-check': CalendarCheck,
  'calendar-range': CalendarRange,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  circle: Circle,
  'circle-check': CircleCheck,
  clock: Clock,
  eye: Eye,
  'eye-off': EyeOff,
  flag: Flag,
  'folder-open': FolderOpen,
  'grip-vertical': GripVertical,
  hash: Hash,
  inbox: Inbox,
  plus: Plus,
  repeat: Repeat,
  sparkles: Sparkles,
};

const ICON_SIZES: Record<ThemeIconSize, number> = {
  xs: 14,
  s: 16,
  m: 18,
  l: 20,
  xl: 32,
};

export function PwaThemeIcon({ id, size, className, ...rest }: ThemeIconProps) {
  const Icon = ICONS[id];
  if (!Icon) {
    return <span className={className} data-icon={id} data-icon-size={size} {...rest} />;
  }

  return (
    <Icon
      className={className}
      data-icon={id}
      data-icon-size={size}
      size={ICON_SIZES[size]}
      {...rest}
    />
  );
}
