import React from "react";
import type { AnimationConfig } from "@/ui/shared/component-adapter";
import type { ReminderDraft } from "./useReminderDraft";
import { DeleteConfirmationModal } from "../DeleteConfirmationModal";
import { DatePickerModal } from "./DatePickerModal";
import { ProjectPickerModal } from "./ProjectPickerModal";
import { RecurrencePickerModal } from "./RecurrencePickerModal";

type AddReminderModalView = "main" | "date" | "project" | "recurrence" | null;

interface AddReminderModalOverlaysProps {
  currentView: AddReminderModalView;
  isClosing: boolean;
  animationConfig: AnimationConfig;
  pickerMode: "replace" | "overlay";
  draft: ReminderDraft;
  isDark: boolean;
  projects: string[];
  defaultProject: string;
  onClosePicker: () => void;
  editorFocus: () => HTMLElement | false;
  showDeleteConfirm: boolean;
  onCloseDeleteConfirm: () => void;
  onConfirmDelete: () => void;
  deleteMessage: string;
  isDeleting: boolean;
}

export const AddReminderModalOverlays: React.FC<AddReminderModalOverlaysProps> = ({
  currentView,
  isClosing,
  animationConfig,
  pickerMode,
  draft,
  isDark,
  projects,
  defaultProject,
  onClosePicker,
  editorFocus,
  showDeleteConfirm,
  onCloseDeleteConfirm,
  onConfirmDelete,
  deleteMessage,
  isDeleting,
}) => {
  return (
    <>
      <DatePickerModal
        isOpen={currentView === "date" && !isClosing}
        onClose={onClosePicker}
        finalFocus={editorFocus}
        animationConfig={animationConfig}
        pickerMode={pickerMode}
        dueDate={draft.dueDate}
        hasTime={draft.hasTime}
        isDark={isDark}
        onDateTimeChange={draft.applyDateSelection}
      />
      <ProjectPickerModal
        isOpen={currentView === "project" && !isClosing}
        onClose={onClosePicker}
        finalFocus={editorFocus}
        animationConfig={animationConfig}
        pickerMode={pickerMode}
        projects={projects}
        project={draft.project}
        defaultProject={defaultProject}
        isDark={isDark}
        onSelectProject={draft.applyProjectSelection}
      />
      <RecurrencePickerModal
        isOpen={currentView === "recurrence" && !isClosing}
        onClose={onClosePicker}
        finalFocus={editorFocus}
        animationConfig={animationConfig}
        pickerMode={pickerMode}
        isDark={isDark}
        recurrence={draft.recurrence}
        onApply={(rule) => draft.applyRecurrenceSelection(rule ?? null)}
      />
      <DeleteConfirmationModal
        isOpen={showDeleteConfirm}
        onClose={onCloseDeleteConfirm}
        onConfirm={onConfirmDelete}
        title="Delete reminder?"
        message={deleteMessage}
        isLoading={isDeleting}
      />
    </>
  );
};
