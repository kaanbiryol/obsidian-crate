import { useState } from "react";
import { Platform } from "obsidian";
import type CratePlugin from "@/main";
import { BaseModal } from "@/reminders/components/BaseModal";
import { ModalHeader } from "@/reminders/components/ModalHeader";
import { RemindersViewContent } from "./reminders-view";

interface ProjectSheetProps {
  plugin: CratePlugin;
  shadowRoot: ShadowRoot;
  initialProject?: string;
  onClose: () => void;
}

export function ProjectSheet({ plugin, shadowRoot, initialProject, onClose }: ProjectSheetProps) {
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
        shadowRoot={shadowRoot}
        isFullScreen
        isModal
        initialTab="browse"
        initialProject={initialProject}
        hideTabBar
        renderHeader={() => <ModalHeader closeLabel="Close projects" onClose={close} />}
      />
    </BaseModal>
  );
}
