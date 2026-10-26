import { useState } from "react";
import { Platform } from "obsidian";
import { BaseModal } from "@/ui/shared/BaseModal";
import { ModalHeader } from "@/ui/shared/ModalHeader";
import { RemindersViewContent } from "./RemindersViewContent";

interface ProjectSheetProps {
  initialProject?: string;
  onClose: () => void;
}

export function ProjectSheet({ initialProject, onClose }: ProjectSheetProps) {
  const [isOpen, setIsOpen] = useState(true);
  const close = () => setIsOpen(false);

  return (
    <BaseModal
      isOpen={isOpen}
      onClose={close}
      onExitComplete={onClose}
      variant={Platform.isMobile ? "bottom-sheet" : "centered"}
      showBackdrop={false}
      showDragHandle={false}
      // Leave vertical gestures to the scrolling and reorderable reminder list.
      disableSwipeToDismiss
      className="crate-project-sheet"
      ariaLabel="Projects"
    >
      <RemindersViewContent
        isFullScreen
        isModal
        initialTab="browse"
        initialProject={initialProject}
        hideTabBar
        renderHeader={(_title, actions) => <ModalHeader closeLabel="Close projects" onClose={close} secondaryActions={actions} />}
      />
    </BaseModal>
  );
}
