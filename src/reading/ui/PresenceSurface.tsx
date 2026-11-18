import { motion, useIsPresent, type HTMLMotionProps } from 'motion/react';

/** A Motion surface that stops taking taps and focus while AnimatePresence animates it out. */
export function PresenceSurface(props: HTMLMotionProps<'div'>) {
	return <motion.div {...props} inert={!useIsPresent()} />;
}
