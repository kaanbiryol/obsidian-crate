import { useState } from "react";
import { Platform } from "obsidian";
import type CratePlugin from "@/main";
import { BaseModal } from "@/reminders/components/BaseModal";
import { ModalHeader } from "@/reminders/components/ModalHeader";
import { RemindersViewContent } from "./RemindersViewContent";

interface ProjectSheetProps {
  plugin: CratePlugin;
  initialProject?: string;
  onClose: () => void;
}

export function ProjectSheet({ plugin, initialProject, onClose }: ProjectSheetProps) {
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
        plugin={plugin}
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
