import { Archive, ArchiveRestore, FileText, Share2, Star, Type, type LucideIcon } from 'lucide-react';
import type { ThemeIconProps } from '@/reminders/components/theme-icon';
import { PwaThemeIcon } from '../components/PwaThemeIcon';

// Article-only icons stay in the deferred Reading bundle.
const icons: Record<string, LucideIcon> = { archive: Archive, 'archive-restore': ArchiveRestore, 'file-text': FileText, 'share-2': Share2, star: Star, type: Type };
const sizes = { xs: 14, s: 16, m: 18, l: 20, xl: 32 };
export function ReadingThemeIcon(props: ThemeIconProps) {
  const Icon = icons[props.id];
  if (!Icon) return <PwaThemeIcon {...props} />;
  const { id, size, ...rest } = props;
  return <Icon {...rest} data-icon={id} data-icon-size={size} size={sizes[size]} />;
}
