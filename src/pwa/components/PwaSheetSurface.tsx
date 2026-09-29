import { useRef, type RefObject } from 'react';
import { motion, type HTMLMotionProps } from 'motion/react';
import { useReducedMotion } from '@/ui/shared/useReducedMotion';
import { useSheetKeyboardMotion } from '../hooks/useSheetKeyboardMotion';

/** A bottom-anchored surface that paints behind the keyboard while its contents stay above it. */
export function PwaSheetSurface({ keyboardInset, surfaceRef, animateKeyboard = true, className = '', style, ...props }: HTMLMotionProps<'div'> & {
	keyboardInset: number;
	surfaceRef?: RefObject<HTMLDivElement | null>;
	animateKeyboard?: boolean;
}) {
	const localRef = useRef<HTMLDivElement | null>(null);
	const reducedMotion = useReducedMotion();
	const setRef = useSheetKeyboardMotion(surfaceRef ?? localRef, keyboardInset, reducedMotion, animateKeyboard);
	return <motion.div {...props} ref={setRef} className={`pwa-sheet-surface ${className}`}
		style={{ ...style, paddingBottom: keyboardInset, '--pwa-keyboard-inset': `${keyboardInset}px` } as HTMLMotionProps<'div'>['style']} />;
}
