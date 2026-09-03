import { memo, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

import type { AnimationConfig } from '../../types/componentAdapter';
import type { Reminder } from '../../types/reminder';
import { ShadowDOMNativeButton } from '../../components/ShadowDOMNativeButton';
import { ThemeIcon } from '../../components/theme-icon';
import {
	REMINDER_LIST_LAYOUT_TRANSITION,
	SPRING_CONFIG_BOUNCY,
} from '../layoutConstants';
import { useObsidianReducedMotion } from '../useObsidianReducedMotion';

export interface CompletedSectionToggleProps {
	onPress: () => void;
	showCompleted: boolean;
	count: number;
}

interface CompletedReminderSectionProps {
	reminders: Reminder[];
	showCompleted: boolean;
	onToggle: () => void;
	renderCard: (reminder: Reminder, index: number) => React.ReactNode;
	renderToggleButton?: (props: CompletedSectionToggleProps) => React.ReactNode;
	animationConfig?: AnimationConfig;
}

export const CompletedReminderSection = memo(function CompletedReminderSection({
	reminders,
	showCompleted,
	onToggle,
	renderCard,
	renderToggleButton,
	animationConfig = { enabled: true },
}: CompletedReminderSectionProps) {
	const animationsEnabled = animationConfig.enabled && !useObsidianReducedMotion();
	const previousCountRef = useRef(reminders.length);
	const shouldAnimateReveal = previousCountRef.current > 0;

	useEffect(() => {
		previousCountRef.current = reminders.length;
	}, [reminders.length]);

	if (reminders.length === 0) {
		return null;
	}

	const toggleProps: CompletedSectionToggleProps = {
		onPress: onToggle,
		showCompleted,
		count: reminders.length,
	};

	return (
		<div
			className="mt-6 pb-4"
			data-reminder-scroll-anchor="true"
			data-reminder-id="completed-section"
			data-reminder-section="section"
		>
			<div className="premium-divider" role="separator" />
			{renderToggleButton ? (
				renderToggleButton(toggleProps)
			) : (
				<ShadowDOMNativeButton
					onClick={onToggle}
					className="completed-section-toggle w-full justify-between h-10 px-0"
					aria-expanded={showCompleted}
				>
					<span className="reminders-muted-label">
						Completed ({reminders.length})
					</span>
					<motion.span
						animate={{ rotate: showCompleted ? 180 : 0 }}
						transition={animationsEnabled ? { duration: 0.2, ease: 'easeOut' } : { duration: 0 }}
						className="inline-flex"
					>
						<ThemeIcon size="m" id="chevron-down" />
					</motion.span>
				</ShadowDOMNativeButton>
			)}

			<AnimatePresence mode="popLayout" initial={false}>
				{showCompleted && (
					<motion.div
						initial={animationsEnabled && shouldAnimateReveal
							? { opacity: 0, height: 0, overflow: 'hidden' }
							: false}
						animate={{
							opacity: 1,
							height: 'auto',
							transition: animationsEnabled ? {
								height: { type: 'spring', ...SPRING_CONFIG_BOUNCY },
								opacity: { duration: 0.2, delay: 0.05 },
							} : { duration: 0 },
							transitionEnd: { overflow: 'visible' },
						}}
						exit={animationsEnabled ? {
							opacity: 0,
							height: 0,
							overflow: 'hidden',
							transition: {
								height: { duration: 0.2 },
								opacity: { duration: 0.15 },
							},
						} : undefined}
						className="mt-3"
					>
						<AnimatePresence mode="popLayout" initial={false}>
							{reminders.map((reminder, index) => (
								<motion.div
									key={reminder.id}
									initial={false}
									animate={{ opacity: 1 }}
									exit={animationsEnabled ? {
										opacity: 0,
										transition: { duration: 0.14, ease: 'easeOut' },
									} : undefined}
									transition={{ opacity: { duration: 0.14, ease: 'easeOut' } }}
									className="premium-reminder-card-wrapper mb-2 reminder-render-item"
									data-reminder-scroll-anchor="true"
									data-reminder-id={reminder.id}
									data-reminder-section="completed"
								>
									<motion.div
										layoutId={animationsEnabled ? `reminder-card-${reminder.id}` : undefined}
										layoutCrossfade={false}
										layout={animationsEnabled ? 'position' : false}
										layoutDependency={reminder.id}
										transition={{ layout: REMINDER_LIST_LAYOUT_TRANSITION }}
									>
										{renderCard(reminder, index)}
									</motion.div>
								</motion.div>
							))}
						</AnimatePresence>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
});
