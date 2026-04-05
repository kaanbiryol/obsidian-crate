import { HeroUIProvider } from "@heroui/react";
import { Modal, Platform } from "obsidian";
import type { ReactElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import type CratePlugin from "@/main";
import { createLogger } from "@/reminders";
import type { Reminder } from "@/reminders/types/plugin-reminder";
import { ReminderModal } from "./createReminderModal";
import { ModalContext, PluginContext } from "./reminders-context";
import { RemindersViewContent } from "./reminders-view";
import { attachPluginStylesheet } from "./shadowStyles";

const log = createLogger("ReminderEditModal");

/**
 * Base class for reminder modals with common setup logic.
 */
abstract class BaseReminderModal extends Modal {
	protected readonly plugin: CratePlugin;
	private root: Root | undefined;

	constructor(plugin: CratePlugin) {
		super(plugin.app);
		this.plugin = plugin;
	}

	protected abstract renderContent(): ReactElement;

	onOpen(): void {
		const { contentEl } = this;
		const isMobile = Platform.isMobile;

		this.modalEl.setCssProps({
			all: "unset",
			position: "fixed",
			inset: "0",
			display: "flex",
			"align-items": isMobile ? "flex-end" : "center",
			"justify-content": "center",
			"pointer-events": "none",
			"z-index": "9999",
		});

		const closeButton = this.modalEl.querySelector(".modal-close-button");
		if (closeButton instanceof HTMLElement) {
			closeButton.setCssProps({ display: "none" });
		}

		contentEl.setCssProps({
			all: "unset",
			"pointer-events": "auto",
			display: "block",
			position: "relative",
			"z-index": "10000",
		});

		const isDarkMode = document.body.classList.contains("theme-dark");
		const close = () => this.close();
		const popoverContainerEl = document.body;

		this.root = createRoot(contentEl);
		this.root.render(
			<PluginContext.Provider value={this.plugin}>
				<HeroUIProvider disableRipple>
					<div className={isDarkMode ? "dark" : "light"}>
						<ModalContext.Provider value={{ close, popoverContainerEl, isMobile }}>
							{this.renderContent()}
						</ModalContext.Provider>
					</div>
				</HeroUIProvider>
			</PluginContext.Provider>,
		);
	}

	onClose(): void {
		this.root?.unmount();
	}
}

class ReminderCreationModal extends BaseReminderModal {
	private readonly initialProject: string | undefined;
	private readonly onCreate: ((reminder: Reminder | null) => void) | undefined;

	constructor(
		plugin: CratePlugin,
		initialProject: string | undefined,
		onCreate?: (reminder: Reminder | null) => void,
	) {
		super(plugin);
		this.initialProject = initialProject;
		this.onCreate = onCreate;
	}

	protected renderContent(): ReactElement {
		return (
			<ReminderModal
				initialProject={this.initialProject}
				onSave={this.onCreate}
			/>
		);
	}
}

class ReminderEditModal extends BaseReminderModal {
	private readonly reminder: Reminder;
	private readonly onUpdate: (action: "saved" | "deleted", reminder?: Reminder) => void;

	constructor(
		plugin: CratePlugin,
		reminder: Reminder,
		onUpdate: (action: "saved" | "deleted", reminder?: Reminder) => void,
	) {
		super(plugin);
		this.reminder = reminder;
		this.onUpdate = onUpdate;
	}

	protected renderContent(): ReactElement {
		return (
			<ReminderModal
				reminder={this.reminder}
				onSave={(updatedReminder: Reminder | null) => {
					log.info(" onSave called:", updatedReminder?.id);
					this.onUpdate("saved", updatedReminder ?? undefined);
				}}
				onDelete={() => {
					log.info(" onDelete called for reminder:", this.reminder.id);
					this.onUpdate("deleted");
				}}
			/>
		);
	}
}

export function openReminderCreationModal(
	plugin: CratePlugin,
	initialProject?: string,
	onCreate?: (reminder: Reminder | null) => void,
): void {
	new ReminderCreationModal(plugin, initialProject, onCreate).open();
}

export function openReminderEditModal(
	plugin: CratePlugin,
	reminder: Reminder,
	onUpdate: (action: "saved" | "deleted", reminder?: Reminder) => void,
): void {
	new ReminderEditModal(plugin, reminder, onUpdate).open();
}

/**
 * Full-screen modal that renders RemindersView as an overlay.
 * Covers the entire viewport including Obsidian's bottom navigation bar.
 */
class FullScreenReminderModal extends Modal {
	private readonly plugin: CratePlugin;
	private readonly initialProject: string | undefined;
	private root: Root | undefined;
	private shadowRoot: ShadowRoot | null = null;

	constructor(plugin: CratePlugin, initialProject?: string) {
		super(plugin.app);
		this.plugin = plugin;
		this.initialProject = initialProject;
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;

		this.modalEl.setCssProps({
			all: "unset",
			position: "fixed",
			inset: "0",
			"z-index": "9999",
			display: "flex",
			"flex-direction": "column",
			background: "var(--background-primary)",
		});

		const closeButton = this.modalEl.querySelector(".modal-close-button");
		if (closeButton instanceof HTMLElement) {
			closeButton.setCssProps({ display: "none" });
		}

		contentEl.setCssProps({
			all: "unset",
			flex: "1",
			display: "flex",
			"flex-direction": "column",
			overflow: "hidden",
			height: "100%",
		});

		this.shadowRoot = contentEl.attachShadow({ mode: "open" });
		await attachPluginStylesheet(this.plugin, this.shadowRoot);

		const mountPoint = document.createElement("div");
		mountPoint.className = "reminders-shadow-root";
		this.shadowRoot.appendChild(mountPoint);

		const close = () => this.close();
		this.root = createRoot(mountPoint);
		this.root.render(
			<PluginContext.Provider value={this.plugin}>
				<RemindersViewContent
					plugin={this.plugin}
					shadowRoot={this.shadowRoot}
					isFullScreen={true}
					onClose={close}
					initialTab={this.plugin.remindersSettings.fullscreenDefaultTab}
					initialProject={this.initialProject}
				/>
			</PluginContext.Provider>,
		);
	}

	onClose(): void {
		this.root?.unmount();
		this.shadowRoot = null;
	}
}

export function openFullScreenReminderModal(plugin: CratePlugin, initialProject?: string): void {
	new FullScreenReminderModal(plugin, initialProject).open();
}

/**
 * Compact modal that renders RemindersView as a centered panel.
 * Sized to ~90% viewport with a max width/height, with rounded corners and backdrop.
 */
class CompactReminderModal extends Modal {
	private readonly plugin: CratePlugin;
	private readonly initialProject: string | undefined;
	private root: Root | undefined;
	private shadowRoot: ShadowRoot | null = null;

	constructor(plugin: CratePlugin, initialProject?: string) {
		super(plugin.app);
		this.plugin = plugin;
		this.initialProject = initialProject;
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;

		this.modalEl.setCssProps({
			all: "unset",
			position: "fixed",
			inset: "0",
			"z-index": "9999",
			display: "flex",
			"align-items": "center",
			"justify-content": "center",
			background: "rgba(0, 0, 0, 0.5)",
		});

		const closeButton = this.modalEl.querySelector(".modal-close-button");
		if (closeButton instanceof HTMLElement) {
			closeButton.setCssProps({ display: "none" });
		}

		contentEl.setCssProps({
			all: "unset",
			display: "flex",
			"flex-direction": "column",
			overflow: "hidden",
			width: "90vw",
			height: "85vh",
			"max-width": "500px",
			"max-height": "700px",
			"border-radius": "12px",
			background: "var(--background-primary)",
			"box-shadow": "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
		});

		this.shadowRoot = contentEl.attachShadow({ mode: "open" });
		await attachPluginStylesheet(this.plugin, this.shadowRoot);

		const mountPoint = document.createElement("div");
		mountPoint.className = "reminders-shadow-root";
		this.shadowRoot.appendChild(mountPoint);

		const close = () => this.close();
		this.root = createRoot(mountPoint);
		this.root.render(
			<PluginContext.Provider value={this.plugin}>
				<RemindersViewContent
					plugin={this.plugin}
					shadowRoot={this.shadowRoot}
					isFullScreen={true}
					onClose={close}
					initialTab="browse"
					initialProject={this.initialProject}
					hideTabBar
				/>
			</PluginContext.Provider>,
		);
	}

	onClose(): void {
		this.root?.unmount();
		this.shadowRoot = null;
	}
}

export function openCompactReminderModal(plugin: CratePlugin, initialProject?: string): void {
	new CompactReminderModal(plugin, initialProject).open();
}
