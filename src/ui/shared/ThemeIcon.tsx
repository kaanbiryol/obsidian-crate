import type React from 'react';
import { createContext, useContext } from 'react';

export type ThemeIconSize = 'xs' | 's' | 'm' | 'l' | 'xl';

export interface ThemeIconProps {
  size: ThemeIconSize;
  id: string;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}

export type ThemeIconRenderer = React.ComponentType<ThemeIconProps>;

const FallbackThemeIcon: ThemeIconRenderer = ({ id, size, className, ...rest }) => (
  <span
    className={['theme-icon', className].filter(Boolean).join(' ')}
    data-icon={id}
    data-icon-size={size}
    {...rest}
  />
);

const ThemeIconContext = createContext<ThemeIconRenderer>(FallbackThemeIcon);

export function ThemeIcon(props: ThemeIconProps) {
  const Renderer = useContext(ThemeIconContext);
  return <Renderer {...props} />;
}

export function ThemeIconProvider({
  children,
  renderer,
}: {
  children: React.ReactNode;
  renderer: ThemeIconRenderer;
}) {
  return (
    <ThemeIconContext.Provider value={renderer}>
      {children}
    </ThemeIconContext.Provider>
  );
}
