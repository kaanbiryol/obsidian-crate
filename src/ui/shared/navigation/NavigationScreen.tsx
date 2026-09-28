import { motion, useIsPresent, type Variants } from 'motion/react';
import React from 'react';
import { PWA_NAVIGATION_SPRING, PWA_FADE } from './motion';

export interface NavigationMotion {
	direction: -1 | 0 | 1;
	reduceMotion: boolean;
}

const variants: Variants = {
	enter: ({ direction, reduceMotion }: NavigationMotion) => ({
		x: reduceMotion || !direction ? 0 : direction === 1 ? '100%' : '-25%',
		opacity: reduceMotion || direction ? 1 : 0,
	}),
	visible: ({ direction, reduceMotion }: NavigationMotion) => ({
		x: 0,
		opacity: 1,
		zIndex: 1,
		transition: reduceMotion ? { duration: 0 } : direction ? PWA_NAVIGATION_SPRING : PWA_FADE,
	}),
	exit: ({ direction, reduceMotion }: NavigationMotion) => ({
		x: reduceMotion || !direction ? 0 : direction === 1 ? '-25%' : '100%',
		opacity: reduceMotion || !direction ? 0 : 1,
		// The detail screen passes over the projects screen in both directions.
		zIndex: direction === -1 ? 2 : 0,
		transition: reduceMotion ? { duration: 0 } : direction ? PWA_NAVIGATION_SPRING : PWA_FADE,
	}),
};

export function NavigationScreen({ children, motion: navigationMotion, isProjectDetail = false }: {
	children: React.ReactNode;
	motion: NavigationMotion;
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
