import React, { useCallback, useRef, useState, forwardRef, memo } from 'react';
import { motion, Reorder, useIsPresent } from 'motion/react';
import type { Reminder } from '../../types/reminder';
import { ReminderListPresence } from './ReminderListPresence';
import { REMINDER_DRAG_SCALE, REMINDER_LIST_LAYOUT_TRANSITION, REMINDER_SECTION_TRANSITION } from './layoutConstants';
import { reminderRowMotion } from './reminderRowMotion';
import { useReducedMotion } from '../../../ui/shared/useReducedMotion';
import { useLongPressReorder } from './useLongPressReorder';
import { mergeReorderedPage, ReminderPagination, useReminderPagination } from './reminder-pagination';

interface ReorderableReminderListProps {
	reminders: Reminder[];
	onReorder: (reordered: Reminder[]) => void;
	onReorderCommit: (orderedIds: string[]) => void;
	onDragActiveChange?: (active: boolean) => void;
	renderCard: (reminder: Reminder, index: number) => React.ReactNode;
	interaction?: 'drag' | 'long-press';
	animationsEnabled?: boolean;
}

interface ReorderableItemProps {
	reminder: Reminder;
	index: number;
	renderCard: (reminder: Reminder, index: number) => React.ReactNode;
	onDragStart: () => void;
	onDragEnd: () => void;
	interaction: 'drag' | 'long-press';
	enableLayoutAnimations: boolean;
}

const LARGE_LIST_ANIMATION_LIMIT = 80;

const ReorderableItem = memo(forwardRef<HTMLDivElement, ReorderableItemProps>(function ReorderableItem({ reminder, index, renderCard, onDragStart, onDragEnd, interaction, enableLayoutAnimations }: ReorderableItemProps, ref) {
	const isPresent = useIsPresent();
	const rowMotion = reminderRowMotion(enableLayoutAnimations);
	const elementRef = useRef<HTMLDivElement | null>(null);
	const setElementRef = useCallback((element: HTMLDivElement | null) => {
		elementRef.current = element;
		if (typeof ref === 'function') ref(element);
		else if (ref) ref.current = element;
	}, [ref]);
	const { dragControls, isDragPressed, isLongPressArmed, isReordering, handlers } = useLongPressReorder({
		elementRef, interaction, onDragStart, onDragEnd,
	});

	return (
		<Reorder.Item
			{...rowMotion}
			ref={setElementRef}
			as="div"
			dragMomentum={false}
			dragTransition={{
				bounceStiffness: REMINDER_LIST_LAYOUT_TRANSITION.stiffness,
				bounceDamping: REMINDER_LIST_LAYOUT_TRANSITION.damping,
			}}
			value={reminder}
			dragListener={false}
			dragControls={dragControls}
			{...handlers}
			layout="position"
			layoutDependency={index}
			data-reminder-scroll-anchor={isPresent ? 'true' : undefined}
			aria-hidden={!isPresent || undefined}
			inert={!isPresent}
			data-reminder-id={reminder.id}
			data-reminder-section="active"
			data-reorder-interaction={interaction}
			className={`reorderable-reminder-item mb-2${isLongPressArmed ? ' is-long-press-armed' : ''}${isReordering ? ' is-reordering' : ''}`}
			whileDrag={{ zIndex: 50 }}
			transition={{
				layout: enableLayoutAnimations ? REMINDER_LIST_LAYOUT_TRANSITION : { duration: 0 },
				...rowMotion.transition,
			}}
		>
			<motion.div
				className="reminder-drag-surface"
				initial={false}
				animate={{ scale: enableLayoutAnimations && (isDragPressed || isLongPressArmed || isReordering) ? REMINDER_DRAG_SCALE : 1 }}
				transition={enableLayoutAnimations ? REMINDER_SECTION_TRANSITION : { duration: 0 }}
				style={{ position: 'relative', display: 'flow-root' }}
			>
				{renderCard(reminder, index)}
			</motion.div>
		</Reorder.Item>
	);
}));

export function ReorderableReminderList({
	reminders,
	onReorder,
	onReorderCommit,
	onDragActiveChange,
	renderCard,
	interaction = 'drag',
	animationsEnabled = true,
}: ReorderableReminderListProps) {
	const reduceMotion = useReducedMotion();
	const pagination = useReminderPagination(reminders);
	const [dragging, setDragging] = useState(false);
	const enableLayoutAnimations = animationsEnabled && !reduceMotion && reminders.length <= LARGE_LIST_ANIMATION_LIMIT;
	const latestOrderRef = useRef(reminders);
	latestOrderRef.current = reminders;
	const orderBeforeDragRef = useRef<string[]>([]);

	const handleDragStart = useCallback(() => {
		setDragging(true);
		orderBeforeDragRef.current = latestOrderRef.current.map(r => r.id);
		onDragActiveChange?.(true);
	}, [onDragActiveChange]);

	const handleDragEnd = useCallback(() => {
		setDragging(false);
		const newOrder = latestOrderRef.current.map(r => r.id);
		const changed = newOrder.length !== orderBeforeDragRef.current.length
			|| newOrder.some((id, i) => id !== orderBeforeDragRef.current[i]);
		if (changed) {
			onReorderCommit(newOrder);
		}
		onDragActiveChange?.(false);
	}, [onReorderCommit, onDragActiveChange]);

	return (
		<>
		<ReminderPagination pagination={pagination} label="Active reminders" disabled={dragging} />
		<Reorder.Group
			as="div"
			axis="y"
			className="reorderable-reminder-list"
			values={pagination.items}
			onReorder={reordered => {
				const merged = mergeReorderedPage(latestOrderRef.current, pagination.items, reordered);
				if (merged) {
					latestOrderRef.current = merged;
					onReorder(merged);
				}
			}}
		>
			<ReminderListPresence>
				{pagination.items.map((reminder, index) => (
					<ReorderableItem
						key={reminder.id}
						reminder={reminder}
						index={pagination.start + index}
						renderCard={renderCard}
						onDragStart={handleDragStart}
						onDragEnd={handleDragEnd}
						interaction={interaction}
						enableLayoutAnimations={enableLayoutAnimations}
					/>
				))}
			</ReminderListPresence>
		</Reorder.Group>
		</>
	);
}
