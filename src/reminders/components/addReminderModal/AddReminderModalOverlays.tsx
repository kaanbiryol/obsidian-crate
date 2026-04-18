import React from "react";
import type { AnimationConfig } from "@/reminders/ui/animations";
import type { Reminder, RecurrenceRule } from "@/reminders/types";
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
  dueDate: string | null;
  hasTime?: boolean;
  isDark: boolean;
  projects: string[];
  project: string;
  defaultProject: string;
  recurrence?: RecurrenceRule;
  onClosePicker: () => void;
  onDateTimeChange: (value: string | null, hasTime?: boolean) => void;
  onSelectProject: (project: string) => void;
  onApplyRecurrence: (rule: RecurrenceRule | null) => void;
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
  dueDate,
  hasTime,
  isDark,
  projects,
  project,
  defaultProject,
  recurrence,
  onClosePicker,
  onDateTimeChange,
  onSelectProject,
  onApplyRecurrence,
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
        animationConfig={animationConfig}
        pickerMode={pickerMode}
        dueDate={dueDate}
        hasTime={hasTime}
        isDark={isDark}
        onDateTimeChange={onDateTimeChange}
      />
      <ProjectPickerModal
        isOpen={currentView === "project" && !isClosing}
        onClose={onClosePicker}
        animationConfig={animationConfig}
        pickerMode={pickerMode}
        projects={projects}
        project={project}
        defaultProject={defaultProject}
        isDark={isDark}
        onSelectProject={onSelectProject}
      />
      <RecurrencePickerModal
        isOpen={currentView === "recurrence" && !isClosing}
        onClose={onClosePicker}
        animationConfig={animationConfig}
        pickerMode={pickerMode}
        isDark={isDark}
        recurrence={recurrence}
        onApply={(rule) => onApplyRecurrence(rule ?? null)}
      />
      <DeleteConfirmationModal
        isOpen={showDeleteConfirm}
        onClose={onCloseDeleteConfirm}
        onConfirm={onConfirmDelete}
        title="Delete Reminder"
        message={deleteMessage}
        animationConfig={animationConfig}
        isLoading={isDeleting}
      />
    </>
  );
};
