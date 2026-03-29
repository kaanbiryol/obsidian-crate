import React, { useRef, useEffect, forwardRef, useCallback } from "react";
import { Button } from "@heroui/react";
import { motion } from "framer-motion";

type NativeButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children"> & {
  onClick: () => void;
  children: React.ReactNode;
};

type NativeMotionButtonProps = Omit<React.ComponentProps<typeof motion.button>, "children" | "onClick" | "ref"> & {
  onClick: () => void;
  children: React.ReactNode;
};

type HeroButtonProps = Omit<React.ComponentProps<typeof Button>, "children" | "onPress"> & {
  onPress: () => void;
  children: React.ReactNode;
};

function assignRef<T>(ref: React.ForwardedRef<T>, value: T | null): void {
  if (typeof ref === "function") {
    ref(value);
    return;
  }

  if (ref) {
    ref.current = value;
  }
}

/**
 * Native button wrapper that works inside Shadow DOM
 * Preserves all styling from className/style props - use for buttons with custom inline styles
 */
export const ShadowDOMNativeButton = forwardRef<HTMLButtonElement, NativeButtonProps>(({ onClick, children, className, style, ...props }, ref) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const combinedRef = useCallback((node: HTMLButtonElement | null) => {
    buttonRef.current = node;
    assignRef(ref, node);
  }, [ref]);

  useEffect(() => {
    const button = buttonRef.current;
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
export const ShadowDOMNativeMotionButton = forwardRef<HTMLButtonElement, NativeMotionButtonProps>(({ onClick, children, className, style, ...props }, ref) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const combinedRef = useCallback((node: HTMLButtonElement | null) => {
    buttonRef.current = node;
    assignRef(ref, node);
  }, [ref]);

  useEffect(() => {
    const button = buttonRef.current;
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
export const ShadowDOMButton = forwardRef<HTMLButtonElement, HeroButtonProps>(({ onPress, children, ...props }, ref) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const combinedRef = useCallback((node: HTMLButtonElement | null) => {
    buttonRef.current = node;
    assignRef(ref, node);
  }, [ref]);

  useEffect(() => {
    const button = buttonRef.current;
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
type MotionHeroButtonProps = Omit<React.ComponentProps<typeof MotionButton>, "children" | "onPress" | "ref"> & {
  onPress: () => void;
  children: React.ReactNode;
};

export const ShadowDOMMotionButton = forwardRef<HTMLButtonElement, MotionHeroButtonProps>(({ onPress, children, ...props }, ref) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const combinedRef = useCallback((node: HTMLButtonElement | null) => {
    buttonRef.current = node;
    assignRef(ref, node);
  }, [ref]);

  useEffect(() => {
    const button = buttonRef.current;
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
