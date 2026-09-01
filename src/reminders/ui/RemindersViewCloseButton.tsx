import React from "react";
import { ShadowDOMNativeButton } from "@/reminders/components/ShadowDOMNativeButton";
import { ObsidianIcon } from "@/reminders/components/obsidian-icon";

interface RemindersViewCloseButtonProps {
  onClose: () => void;
}

export const RemindersViewCloseButton: React.FC<RemindersViewCloseButtonProps> = ({
  onClose,
}) => {
  return (
    <ShadowDOMNativeButton
      onClick={onClose}
      className="reminders-view-close"
      aria-label="Close"
    >
      <ObsidianIcon size="l" id="x" />
    </ShadowDOMNativeButton>
  );
};
