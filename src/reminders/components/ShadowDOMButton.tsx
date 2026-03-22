import React, { useRef, useEffect, forwardRef } from "react";
import { Button } from "@heroui/react";
import { motion } from "framer-motion";

/**
 * Native button wrapper that works inside Shadow DOM
 * Preserves all styling from className/style props - use for buttons with custom inline styles
 */
export const ShadowDOMNativeButton = forwardRef<HTMLButtonElement, {
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  [key: string]: any;
}>(({ onClick, children, className, style, ...props }, ref) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const combinedRef = (ref as React.RefObject<HTMLButtonElement>) || buttonRef;

  useEffect(() => {
    const button = combinedRef?.current;
    if (!button) return;

    const handleClick = (e: MouseEvent) => {
      e.stopPropagation();
      onClick();
    };

    button.addEventListener('click', handleClick, true);
    return () => button.removeEventListener('click', handleClick, true);
  }, [onClick, combinedRef]);

  return (
    <button ref={combinedRef} className={className} style={style} {...props}>
      {children}
    </button>
  );
});

ShadowDOMNativeButton.displayName = 'ShadowDOMNativeButton';

/**
 * Native motion.button wrapper that works inside Shadow DOM
 * Preserves all styling and motion props - use for animated buttons with custom inline styles
 */
export const ShadowDOMNativeMotionButton = forwardRef<HTMLButtonElement, {
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  [key: string]: any;
}>(({ onClick, children, className, style, ...props }, ref) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const combinedRef = (ref as React.RefObject<HTMLButtonElement>) || buttonRef;

  useEffect(() => {
    const button = combinedRef?.current;
    if (!button) return;

    const handleClick = (e: MouseEvent) => {
      e.stopPropagation();
      onClick();
    };

    button.addEventListener('click', handleClick, true);
    return () => button.removeEventListener('click', handleClick, true);
  }, [onClick, combinedRef]);

  return (
    <motion.button ref={combinedRef} className={className} style={style} {...props}>
      {children}
    </motion.button>
  );
});

ShadowDOMNativeMotionButton.displayName = 'ShadowDOMNativeMotionButton';

/**
 * HeroUI Button wrapper that works inside Shadow DOM
 * Uses native click handler via capture phase since HeroUI's onPress doesn't work in Shadow DOM
 */
export const ShadowDOMButton = forwardRef<HTMLButtonElement, {
  onPress: () => void;
  children: React.ReactNode;
  [key: string]: any;
}>(({ onPress, children, ...props }, ref) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const combinedRef = (ref as React.RefObject<HTMLButtonElement>) || buttonRef;

  useEffect(() => {
    const button = combinedRef?.current;
    if (!button) return;

    const handleClick = (e: MouseEvent) => {
      e.stopPropagation();
      onPress();
    };

    button.addEventListener('click', handleClick, true);
    return () => button.removeEventListener('click', handleClick, true);
  }, [onPress, combinedRef]);

  return (
    <Button ref={combinedRef} {...props}>
      {children}
    </Button>
  );
});

ShadowDOMButton.displayName = 'ShadowDOMButton';

/**
 * Motion-enabled Button wrapper that works inside Shadow DOM
 * Combines framer-motion animations with capture-phase click handling
 */
const MotionButton = motion.create(Button);

export const ShadowDOMMotionButton = forwardRef<HTMLButtonElement, {
  onPress: () => void;
  children: React.ReactNode;
  [key: string]: any;
}>(({ onPress, children, ...props }, ref) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const combinedRef = (ref as React.RefObject<HTMLButtonElement>) || buttonRef;

  useEffect(() => {
    const button = combinedRef?.current;
    if (!button) return;

    const handleClick = (e: MouseEvent) => {
      e.stopPropagation();
      onPress();
    };

    button.addEventListener('click', handleClick, true);
    return () => button.removeEventListener('click', handleClick, true);
  }, [onPress, combinedRef]);

  return (
    <MotionButton ref={combinedRef} {...props}>
      {children}
    </MotionButton>
  );
});

ShadowDOMMotionButton.displayName = 'ShadowDOMMotionButton';
