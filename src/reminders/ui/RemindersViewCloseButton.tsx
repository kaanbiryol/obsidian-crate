import React from "react";
import { X } from "lucide-react";
import { ShadowDOMNativeButton } from "@/reminders/components/ShadowDOMButton";

interface RemindersViewCloseButtonProps {
  isDarkMode: boolean;
  onClose: () => void;
}

export const RemindersViewCloseButton: React.FC<RemindersViewCloseButtonProps> = ({
  isDarkMode,
  onClose,
}) => {
  const background = isDarkMode ? "rgba(255, 255, 255, 0.04)" : "rgba(0, 0, 0, 0.03)";
  const border = isDarkMode ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)";
  const hoverBackground = isDarkMode ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.06)";
  const baseShadow = isDarkMode ? "rgba(0, 0, 0, 0.12)" : "rgba(0, 0, 0, 0.04)";
  const hoverShadow = isDarkMode ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.08)";

  return (
    <ShadowDOMNativeButton
      onClick={onClose}
      className="flex items-center justify-center w-11 h-11 rounded-full transition-all duration-200 active:scale-95"
      aria-label="Close"
      style={{
        position: "absolute",
        top: "12px",
        right: "16px",
        zIndex: 100,
        background,
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        border: `1px solid ${border}`,
        color: "var(--text-muted)",
        boxShadow: `0 2px 8px ${baseShadow}`,
        transition: "all 200ms ease-out",
      }}
      onMouseEnter={(event: React.MouseEvent<HTMLButtonElement>) => {
        event.currentTarget.style.background = hoverBackground;
        event.currentTarget.style.boxShadow = `0 0 12px ${hoverShadow}`;
      }}
      onMouseLeave={(event: React.MouseEvent<HTMLButtonElement>) => {
        event.currentTarget.style.background = background;
        event.currentTarget.style.boxShadow = `0 2px 8px ${baseShadow}`;
      }}
    >
      <X size={24} strokeWidth={2.5} />
    </ShadowDOMNativeButton>
  );
};
