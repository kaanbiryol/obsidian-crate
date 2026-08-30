import React from "react";
import { X } from "lucide-react";
import { ShadowDOMNativeButton } from "@/reminders/components/ShadowDOMNativeButton";

interface RemindersViewCloseButtonProps {
  onClose: () => void;
}

export const RemindersViewCloseButton: React.FC<RemindersViewCloseButtonProps> = ({
  onClose,
}) => {
  return (
    <ShadowDOMNativeButton
      onClick={onClose}
      className="reminders-view-close flex items-center justify-center w-11 h-11 rounded-full active:scale-95"
      aria-label="Close"
    >
      <X size={24} strokeWidth={2.5} />
    </ShadowDOMNativeButton>
  );
};
