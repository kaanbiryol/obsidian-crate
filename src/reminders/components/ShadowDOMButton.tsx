import React, { forwardRef } from "react";
import { Button } from "@heroui/react";
import { motion } from "framer-motion";
import { useShadowDomClickBridge } from './shadowDomClickBridge';

type HeroButtonProps = Omit<React.ComponentProps<typeof Button>, "children" | "onPress"> & {
  onPress: () => void;
  children: React.ReactNode;
};

/**
 * HeroUI Button wrapper that works inside Shadow DOM
 * Uses native click handler via capture phase since HeroUI's onPress doesn't work in Shadow DOM
 */
export const ShadowDOMButton = forwardRef<HTMLButtonElement, HeroButtonProps>(({ onPress, children, type = "button", ...props }, ref) => {
  const combinedRef = useShadowDomClickBridge(onPress, ref);

  return (
    <Button ref={combinedRef} type={type} {...props}>
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

export const ShadowDOMMotionButton = forwardRef<HTMLButtonElement, MotionHeroButtonProps>(({ onPress, children, type = "button", ...props }, ref) => {
  const combinedRef = useShadowDomClickBridge(onPress, ref);

  return (
    <MotionButton ref={combinedRef} type={type} {...props}>
      {children}
    </MotionButton>
  );
});

ShadowDOMMotionButton.displayName = 'ShadowDOMMotionButton';
