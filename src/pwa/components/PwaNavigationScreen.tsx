import { motion, useIsPresent, type Variants } from 'motion/react';
import React from 'react';
import { PWA_NAVIGATION_SPRING } from '../motion';

export interface PwaNavigationMotion {
	direction: -1 | 0 | 1;
	reduceMotion: boolean;
}

const variants: Variants = {
	enter: ({ direction, reduceMotion }: PwaNavigationMotion) => ({
		x: reduceMotion || !direction ? 0 : direction === 1 ? '100%' : '-25%',
		opacity: reduceMotion || direction ? 1 : 0,
	}),
	visible: ({ direction, reduceMotion }: PwaNavigationMotion) => ({
		x: 0,
		opacity: 1,
		zIndex: 1,
		transition: reduceMotion ? { duration: 0 } : direction ? PWA_NAVIGATION_SPRING : { duration: 0.18, ease: 'easeInOut' },
	}),
	exit: ({ direction, reduceMotion }: PwaNavigationMotion) => ({
		x: reduceMotion || !direction ? 0 : direction === 1 ? '-25%' : '100%',
		opacity: reduceMotion || !direction ? 0 : 1,
		// The detail screen passes over the projects screen in both directions.
		zIndex: direction === -1 ? 2 : 0,
		transition: reduceMotion ? { duration: 0 } : direction ? PWA_NAVIGATION_SPRING : { duration: 0.18, ease: 'easeInOut' },
	}),
};

export function PwaNavigationScreen({ children, motion: navigationMotion, isProjectDetail = false }: {
	children: React.ReactNode;
	motion: PwaNavigationMotion;
	isProjectDetail?: boolean;
}) {
	const isPresent = useIsPresent();
	return (
		<motion.div
			className={`pwa-navigation-screen${isProjectDetail ? ' pwa-navigation-screen--project' : ''}`}
			custom={navigationMotion}
			variants={variants}
			initial="enter"
			animate="visible"
			exit="exit"
			inert={!isPresent}
			aria-hidden={!isPresent || undefined}
			style={{ zIndex: 1 }}
		>
			{children}
		</motion.div>
	);
}
