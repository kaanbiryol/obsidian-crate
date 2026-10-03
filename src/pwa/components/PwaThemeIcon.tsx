import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  FileText,
  Link,
  LogOut,
  Search,
  Share2,
  Star,
  Type,
  Calendar,
  BookOpen,
  ListTodo,
  Settings,
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
  ChevronRight,
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
  Highlighter,
  Inbox,
  Plus,
  Repeat,
  Sparkles,
  SquarePen,
  Smartphone,
  type LucideIcon,
} from 'lucide-react';

import type { ThemeIconProps, ThemeIconSize } from '@/ui/shared/ThemeIcon';

const ICONS: Record<string, LucideIcon> = {
  archive: Archive,
  'archive-restore': ArchiveRestore,
  'arrow-up-right': ArrowUpRight,
  'file-text': FileText,
  link: Link,
  'log-out': LogOut,
  search: Search,
  'share-2': Share2,
  star: Star,
  type: Type,
  'book-open': BookOpen,
  'list-todo': ListTodo,
  settings: Settings,
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
  'chevron-right': ChevronRight,
  circle: Circle,
  'circle-check': CircleCheck,
  clock: Clock,
  eye: Eye,
  'eye-off': EyeOff,
  flag: Flag,
  'folder-open': FolderOpen,
  'grip-vertical': GripVertical,
  hash: Hash,
  highlighter: Highlighter,
  inbox: Inbox,
  plus: Plus,
  repeat: Repeat,
  sparkles: Sparkles,
  'square-pen': SquarePen,
  smartphone: Smartphone,
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
