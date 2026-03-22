/**
 * Obsidian UI utilities
 *
 * Theme utilities now assume Obsidian-only styling.
 */

/**
 * Typography size mappings for inline styles
 * Uses Obsidian typography CSS variables.
 */
type TypographySize = 'base' | 'sm' | 'xs' | 'xxs' | 'lg';

/**
 * Font weight mappings
 */
type FontWeight = 'normal' | 'medium' | 'semibold';

/**
 * Get font size value for inline styles
 */
export const getFontSize = (size: TypographySize): string => {
  const sizeMap: Record<TypographySize, string> = {
    lg: 'var(--font-text-size)',
    base: 'var(--font-text-size)',
    sm: 'var(--font-small)',
    xs: 'var(--font-smaller)',
    xxs: 'var(--font-smallest)',
  };
  return sizeMap[size];
};

/**
 * Get font weight value for inline styles
 */
export const getFontWeight = (weight: FontWeight): string => {
  const weightMap: Record<FontWeight, string> = {
    normal: '400',
    medium: '500',
    semibold: 'var(--font-semibold)',
  };
  return weightMap[weight];
};
