import type { ReactNode } from 'react';
import { motion, type MotionProps } from 'framer-motion';

type PickerSectionMotionProps = Pick<
	MotionProps,
	'initial' | 'animate' | 'exit' | 'transition'
>;

interface PickerSectionProps {
	headingId: string;
	title: string;
	action?: ReactNode;
	children: ReactNode;
	className?: string;
	motionProps?: PickerSectionMotionProps;
}

function SectionHeading({ headingId, title, action }: Pick<PickerSectionProps, 'headingId' | 'title' | 'action'>) {
	return (
		<div className="picker-section-heading">
			<h4 id={headingId}>{title}</h4>
			{action}
		</div>
	);
}

export function PickerSection({
	headingId,
	title,
	action,
	children,
	className,
	motionProps,
}: PickerSectionProps) {
	const classes = ['picker-section', className].filter(Boolean).join(' ');

	if (motionProps) {
		return (
			<motion.section
				{...motionProps}
				className={classes}
				aria-labelledby={headingId}
			>
				<SectionHeading headingId={headingId} title={title} action={action} />
				{children}
			</motion.section>
		);
	}

	return (
		<section className={classes} aria-labelledby={headingId}>
			<SectionHeading headingId={headingId} title={title} action={action} />
			{children}
		</section>
	);
}
