import type { ReactNode } from 'react';
import { ModalHeader } from './ModalHeader';

interface ModalLayoutProps {
    title: string;
    onClose: () => void;
    children: ReactNode;
    footer?: ReactNode;
    closeDisabled?: boolean;
}

/** Content layout hosted by an Obsidian modal; the host owns focus and dismissal. */
export function ModalLayout({ title, onClose, children, footer, closeDisabled }: ModalLayoutProps) {
    return <>
        <ModalHeader title={title} closeLabel="Close dialog" onClose={onClose} closeDisabled={closeDisabled} titleLive="polite" />
        <div className="crate-modal-body">{children}</div>
        {footer && <div className="crate-modal-footer">{footer}</div>}
    </>;
}
