import { TriangleAlert } from 'lucide-react';
import type { ThemeIconProps } from '@/reminders/components/theme-icon';
import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeIconProvider } from '@/reminders/components/theme-icon';
import { PwaThemeIcon } from '@/pwa/components/PwaThemeIcon';
import { DatePickerContent } from '@/reminders/ui/reminder-modal/DatePickerContent';
import { ProjectPickerContent } from '@/reminders/ui/reminder-modal/ProjectPickerContent';
import { RecurrencePickerContent } from '@/reminders/ui/reminder-modal/RecurrencePickerContent';
import { ReminderEditorFields } from '@/reminders/ui/reminder-modal/ReminderEditorFields';
import { ReminderActionChips } from '@/reminders/ui/reminder-modal/ReminderActionChips';
import type { RecurrencePickerState } from '@/reminders/ui/reminder-modal/recurrencePickerShared';
import type { RichTextInputHandle } from '@/reminders/components/RichTextInput';
import { ModalLayout } from '@/ui/shared/ModalLayout';
import { StatusContent } from '@/ui/shared/StatusContent';
import { Button } from '@/ui/shared/Button';
import { ModalHeader } from '@/ui/shared/ModalHeader';
import { ReminderCard } from '@/reminders/components/ReminderCard';
import { PWA_STYLES, PWA_LIGHT_THEME_STYLES } from '@/cloudflare/worker/pwa/styles';
import pluginStyles from '../../../dist/styles.css?raw';
import fixtureStyles from './fixture.css?raw';

const params = new URLSearchParams(location.search);
const host = params.get('host') === 'plugin' ? 'plugin' : 'pwa';
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const scene = params.get('scene') || 'date';
const isDark = theme === 'dark';
const projects = ['Inbox', 'Work', 'Personal', 'A project with a deliberately long name to check truncation'];
document.documentElement.dataset.scene = scene;
document.documentElement.dataset.host = host;
document.documentElement.dataset.theme = theme;
const style = document.createElement('style');
style.textContent = (host === 'plugin' ? pluginStyles : PWA_STYLES + (isDark ? '' : PWA_LIGHT_THEME_STYLES)) + fixtureStyles;
document.head.append(style);

function GalleryIcon(props: ThemeIconProps) {
  return props.id === 'triangle-alert' ? <TriangleAlert size={18} aria-hidden="true" /> : <PwaThemeIcon {...props} />;
}

function Gallery() {
  const [result, setResult] = useState('Ready');
  const [project, setProject] = useState('Work');
  const [title, setTitle] = useState('Review the shared reminder controls');
  const [description, setDescription] = useState('A longer description that wraps on a narrow screen. Check typography, spacing, and the circular completion controls.');
  const [date, setDate] = useState('2026-09-06');
  const [recurrence, setRecurrence] = useState<RecurrencePickerState>({ frequency: scene === 'monthly' ? 'monthly' as const : 'weekly' as const, interval: 2, daysOfWeek: [1, 3], dayOfMonth: 15, hour: 9, minute: 30 });
  const titleRef = useRef<HTMLDivElement>(null);
  const richRef = useRef<RichTextInputHandle>(null);
  const noop = () => setResult('Closed');
  let content: React.ReactNode;
  if (scene === 'status') content = <ModalLayout title="Server reset failed" onClose={noop} footer={<div className="crate-status-actions"><Button onClick={noop}>Close</Button><Button className="mod-cta" onClick={() => setResult('Settings opened')}>Open settings</Button></div>}><StatusContent state="error" description="Crate couldn’t finish resetting your Cloudflare server." details={['In Crate settings → Troubleshooting, select “Resume server reset” to try again.']} technicalDetails="Could not verify the complete Durable Object namespace listing." /></ModalLayout>;
  else if (scene === 'project') content = <ProjectPickerContent isOpen projects={projects} project={project} defaultProject="Inbox" isDark={isDark} onSelectProject={setProject} onClose={noop} />;
  else if (scene === 'weekly' || scene === 'monthly') content = <RecurrencePickerContent state={recurrence} onChange={patch => setRecurrence(current => ({ ...current, ...patch }))} isDark={isDark} animationsEnabled={false} canRemove onClose={noop} onDone={() => setResult('Applied')} onRemove={() => setResult('Removed')} />;
  else if (scene === 'editor') content = <><ModalHeader title="New reminder" closeLabel="Close reminder editor" onClose={noop} action={{ label: 'Add', onClick: () => setResult('Saved') }} /><div className="reminder-modal-body"><ReminderEditorFields content={title} onContentChange={setTitle} description={description} onDescriptionChange={setDescription} allowAutoFocus={false} projects={projects} textareaRef={titleRef} richTextInputRef={richRef} /><ReminderActionChips dueDate={null} project={project} defaultProject="Inbox" priority={1} onOpenDatePicker={noop} onOpenProjectPicker={noop} onOpenRecurrencePicker={noop} onTogglePriority={noop} /></div></>;
  else if (scene === 'cards') content = <div className="reminders-view is-primary"><ReminderCard reminder={{ id: '1', content: 'Review the shared UI', description, completed: false, project: 'Work', priority: 1, dueDate: '2026-09-04' }} colorScheme={theme} animationConfig={{ enabled: false }} /><ReminderCard reminder={{ id: '2', content: 'Completed reminder', completed: true, project: 'Inbox' }} colorScheme={theme} animationConfig={{ enabled: false }} /></div>;
  else content = <DatePickerContent currentDate={date ? new Date(`${date}T09:30:00`) : null} hasTime isDark={isDark} commitDateOnChange={host === 'pwa'} onClose={noop} onSelectPreset={preset => setResult(preset)} onDateChange={value => { setDate(value); setResult(value); }} onTimeChange={(hour, minute) => setResult(`${hour}:${minute}`)} onTimeClear={() => setResult('Cleared time')} onRemove={() => setResult('Removed')} />;
  return <ThemeIconProvider renderer={GalleryIcon}><div className={`crate-reminders-ui reminders-shadow-root ${host === 'pwa' ? 'pwa-shadow-root' : ''}`}><main data-testid="visual-surface" className={`visual-surface ${host === 'pwa' ? scene === 'editor' ? 'modal-card pwa-reminder-editor' : 'pwa-picker-sheet' : 'base-modal-surface'} ${isDark ? 'dark' : ''}`}><div className="visual-content">{content}</div></main><output data-testid="result">{result}</output></div></ThemeIconProvider>;
}

createRoot(document.getElementById('app')!).render(<Gallery />);
