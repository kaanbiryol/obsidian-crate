import React from "react";
import { IconButton } from "@/reminders/components/IconButton";

interface RemindersViewCloseButtonProps {
  onClose: () => void;
}

export const RemindersViewCloseButton: React.FC<RemindersViewCloseButtonProps> = ({
  onClose,
}) => {
  return (
    <IconButton
      icon="x"
      iconSize="l"
      onClick={onClose}
      className="reminders-view-close"
      label="Close"
      size="large"
      variant="surface"
    />
  );
};
