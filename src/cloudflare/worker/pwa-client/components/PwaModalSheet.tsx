import React from 'react';
import {
	Sheet,
	type SheetDetent,
	type SheetTweenConfig,
} from 'react-modal-sheet';

const OPEN_TWEEN: SheetTweenConfig = {
	ease: [0.32, 0.72, 0, 1],
	duration: 0.36,
};

const CLOSE_TWEEN: SheetTweenConfig = {
	ease: [0.4, 0, 1, 1],
	duration: 0.26,
};

export function PwaModalSheet({
	isOpen,
	onClose,
	onOpenEnd,
	onCloseEnd,
	children,
	variant,
	detent = 'default',
	keyboardInset = 0,
	closeOnBackdrop = true,
	onKeyDown,
}: {
	isOpen: boolean;
	onClose: () => void;
	onOpenEnd?: () => void;
	onCloseEnd: () => void;
	children: React.ReactNode;
	variant: 'reminder' | 'settings';
	detent?: SheetDetent;
	keyboardInset?: number;
	closeOnBackdrop?: boolean;
	onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
}) {
	const mountPoint = typeof document === 'undefined'
		? undefined
		: document.querySelector<HTMLElement>('.pwa-shadow-root') ?? undefined;
	const containerStyle = keyboardInset > 0
		? ({
			'--pwa-keyboard-inset': `${keyboardInset}px`,
		} as React.CSSProperties)
		: undefined;

	return (
		<Sheet
			isOpen={isOpen}
			onClose={onClose}
			onOpenEnd={onOpenEnd}
			onCloseEnd={onCloseEnd}
			mountPoint={mountPoint}
			detent={detent}
			disableDrag
			disableDismiss
			avoidKeyboard={false}
			unstyled
			tweenConfig={isOpen ? OPEN_TWEEN : CLOSE_TWEEN}
			className={`pwa-modal-sheet pwa-modal-sheet--${variant}${keyboardInset > 0 ? ' is-keyboard-open' : ''}`}
			onKeyDown={onKeyDown}
		>
			<Sheet.Backdrop
				className="pwa-modal-sheet__backdrop"
				aria-label={closeOnBackdrop ? 'Close sheet' : undefined}
				onClick={closeOnBackdrop ? onClose : undefined}
			/>
			<Sheet.Container
				className={`pwa-modal-sheet__container pwa-modal-sheet__container--${variant}`}
				style={containerStyle}
			>
				<Sheet.Content
					disableDrag
					disableScroll
					className="pwa-modal-sheet__content"
					scrollClassName="pwa-modal-sheet__scroller"
				>
					{children}
				</Sheet.Content>
			</Sheet.Container>
		</Sheet>
	);
}
