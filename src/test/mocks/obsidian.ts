type DomElementInfo = {
	text?: string;
	cls?: string;
	href?: string;
	attr?: Record<string, string | number | boolean | null>;
};

function applyDomInfo(el: HTMLElement, info?: DomElementInfo | string): void {
	if (!info) {
		return;
	}

	if (typeof info === 'string') {
		el.addClass(info);
		return;
	}

	if (info.text) {
		el.setText(info.text);
	}

	if (info.cls) {
		el.addClasses(info.cls.split(/\s+/).filter(Boolean));
	}

	if (info.href) {
		el.setAttribute('href', info.href);
	}

	if (info.attr) {
		for (const [key, value] of Object.entries(info.attr)) {
			if (value === null) {
				el.removeAttribute(key);
				continue;
			}
			el.setAttribute(key, String(value));
		}
	}
}

function setElementContent(el: HTMLElement, value: string | DocumentFragment): void {
	el.empty();
	if (typeof value === 'string') {
		el.setText(value);
		return;
	}
	el.appendChild(value);
}

function installDomHelpers(): void {
	if (typeof Element === 'undefined' || (Element.prototype as { createEl?: unknown }).createEl) {
		return;
	}

	Node.prototype.detach = function detach(): void {
		this.parentNode?.removeChild(this);
	};

	Node.prototype.empty = function empty(): void {
		while (this.firstChild) {
			this.removeChild(this.firstChild);
		}
	};

	Node.prototype.appendText = function appendText(value: string): void {
		this.appendChild(this.ownerDocument!.createTextNode(value));
	};

	Element.prototype.setText = function setText(value: string | DocumentFragment): void {
		if (typeof value === 'string') {
			this.textContent = value;
			return;
		}

		this.empty();
		this.appendChild(value);
	};

	Element.prototype.addClass = function addClass(...classes: string[]): void {
		this.classList.add(...classes);
	};

	Element.prototype.addClasses = function addClasses(classes: string[]): void {
		this.classList.add(...classes);
	};

	Element.prototype.removeClass = function removeClass(...classes: string[]): void {
		this.classList.remove(...classes);
	};

	Element.prototype.removeClasses = function removeClasses(classes: string[]): void {
		this.classList.remove(...classes);
	};

	Element.prototype.toggleClass = function toggleClass(classes: string | string[], value: boolean): void {
		const resolved = Array.isArray(classes) ? classes : [classes];
		for (const cls of resolved) {
			this.classList.toggle(cls, value);
		}
	};

	Element.prototype.hasClass = function hasClass(cls: string): boolean {
		return this.classList.contains(cls);
	};

	Element.prototype.setAttr = function setAttr(name: string, value: string | number | boolean | null): void {
		if (value === null) {
			this.removeAttribute(name);
			return;
		}
		this.setAttribute(name, String(value));
	};

	Element.prototype.setAttrs = function setAttrs(values: Record<string, string | number | boolean | null>): void {
		for (const [name, value] of Object.entries(values)) {
			this.setAttr(name, value);
		}
	};

	Element.prototype.getAttr = function getAttr(name: string): string | null {
		return this.getAttribute(name);
	};

	Element.prototype.createEl = function createEl<K extends keyof HTMLElementTagNameMap>(
		tag: K,
		info?: DomElementInfo | string,
		callback?: (el: HTMLElementTagNameMap[K]) => void,
	): HTMLElementTagNameMap[K] {
		const el = this.ownerDocument.createElement(tag);
		applyDomInfo(el, info);
		this.appendChild(el);
		callback?.(el);
		return el;
	};

	Element.prototype.createDiv = function createDiv(
		info?: DomElementInfo | string,
		callback?: (el: HTMLDivElement) => void,
	): HTMLDivElement {
		return this.createEl('div', info, callback);
	};

	HTMLElement.prototype.show = function show(): void {
		this.setCssProps({ display: '' });
	};

	HTMLElement.prototype.hide = function hide(): void {
		this.setCssProps({ display: 'none' });
	};

	HTMLElement.prototype.toggle = function toggle(show: boolean): void {
		if (show) {
			this.show();
		} else {
			this.hide();
		}
	};

	HTMLElement.prototype.toggleVisibility = function toggleVisibility(visible: boolean): void {
		this.toggle(visible);
	};

	HTMLElement.prototype.isShown = function isShown(): boolean {
		return this.style.display !== 'none';
	};

	HTMLElement.prototype.setCssStyles = function setCssStyles(styles: Partial<CSSStyleDeclaration>): void {
		Object.assign(this.style, styles);
	};

	HTMLElement.prototype.setCssProps = function setCssProps(props: Record<string, string>): void {
		for (const [name, value] of Object.entries(props)) {
			this.style.setProperty(name, value);
		}
	};
}

installDomHelpers();

export class TAbstractFile {
	path: string;
	name: string;
	parent: TFolder | null;

	constructor(path = '') {
		this.path = path;
		this.name = path.split('/').pop() ?? path;
		this.parent = null;
	}
}

export class TFile extends TAbstractFile {
	basename: string;
	extension: string;
	stat: { size: number; mtime: number; ctime: number };

	constructor(path = '', stat?: Partial<{ size: number; mtime: number; ctime: number }>) {
		super(path);
		const lastDot = this.name.lastIndexOf('.');
		this.basename = lastDot >= 0 ? this.name.slice(0, lastDot) : this.name;
		this.extension = lastDot >= 0 ? this.name.slice(lastDot + 1) : '';
		this.stat = {
			size: 0,
			mtime: 0,
			ctime: 0,
			...stat,
		};
	}
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[];

	constructor(path = '') {
		super(path);
		this.children = [];
	}
}

export class Notice {
	static messages: string[] = [];

	constructor(message?: string) {
		if (message) {
			Notice.messages.push(message);
		}
	}

	static reset(): void {
		Notice.messages = [];
	}
}

class BaseMockComponent {
	protected readonly targetEl: HTMLElement;

	constructor(targetEl: HTMLElement) {
		this.targetEl = targetEl;
	}

	setDisabled(disabled: boolean): this {
		if ('disabled' in this.targetEl) {
			(this.targetEl as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled = disabled;
		}
		return this;
	}

	setTooltip(tooltip: string): this {
		this.targetEl.setAttribute('aria-label', tooltip);
		return this;
	}
}

export class ButtonComponent extends BaseMockComponent {
	readonly buttonEl: HTMLButtonElement;

	constructor(containerEl: HTMLElement) {
		super(containerEl.createEl('button'));
		this.buttonEl = this.targetEl as HTMLButtonElement;
	}

	setButtonText(text: string): this {
		this.buttonEl.setText(text);
		return this;
	}

	setWarning(): this {
		this.buttonEl.addClass('mod-warning');
		return this;
	}

	setCta(): this {
		this.buttonEl.addClass('mod-cta');
		return this;
	}

	setIcon(icon: string): this {
		this.buttonEl.setAttribute('data-icon', icon);
		return this;
	}

	onClick(callback: (event: MouseEvent) => unknown): this {
		this.buttonEl.addEventListener('click', (event) => {
			void callback(event);
		});
		return this;
	}
}

export class ExtraButtonComponent extends ButtonComponent {}

export class ToggleComponent extends BaseMockComponent {
	readonly toggleEl: HTMLInputElement;

	constructor(containerEl: HTMLElement) {
		const inputEl = containerEl.createEl('input');
		inputEl.type = 'checkbox';
		super(inputEl);
		this.toggleEl = inputEl;
	}

	setValue(value: boolean): this {
		this.toggleEl.checked = value;
		return this;
	}

	onChange(callback: (value: boolean) => unknown): this {
		this.toggleEl.addEventListener('change', () => {
			void callback(this.toggleEl.checked);
		});
		return this;
	}
}

export class TextComponent extends BaseMockComponent {
	readonly inputEl: HTMLInputElement;

	constructor(containerEl: HTMLElement) {
		super(containerEl.createEl('input'));
		this.inputEl = this.targetEl as HTMLInputElement;
	}

	setValue(value: string): this {
		this.inputEl.value = value;
		return this;
	}

	setPlaceholder(value: string): this {
		this.inputEl.placeholder = value;
		return this;
	}

	onChange(callback: (value: string) => unknown): this {
		this.inputEl.addEventListener('input', () => {
			void callback(this.inputEl.value);
		});
		return this;
	}
}

export class TextAreaComponent extends BaseMockComponent {
	readonly inputEl: HTMLTextAreaElement;

	constructor(containerEl: HTMLElement) {
		super(containerEl.createEl('textarea'));
		this.inputEl = this.targetEl as HTMLTextAreaElement;
	}

	setValue(value: string): this {
		this.inputEl.value = value;
		return this;
	}

	setPlaceholder(value: string): this {
		this.inputEl.placeholder = value;
		return this;
	}

	onChange(callback: (value: string) => unknown): this {
		this.inputEl.addEventListener('input', () => {
			void callback(this.inputEl.value);
		});
		return this;
	}
}

export class DropdownComponent extends BaseMockComponent {
	readonly selectEl: HTMLSelectElement;

	constructor(containerEl: HTMLElement) {
		super(containerEl.createEl('select'));
		this.selectEl = this.targetEl as HTMLSelectElement;
	}

	addOption(value: string, label: string): this {
		const option = this.selectEl.createEl('option');
		option.value = value;
		option.setText(label);
		this.selectEl.appendChild(option);
		return this;
	}

	setValue(value: string): this {
		this.selectEl.value = value;
		return this;
	}

	onChange(callback: (value: string) => unknown): this {
		this.selectEl.addEventListener('change', () => {
			void callback(this.selectEl.value);
		});
		return this;
	}
}

export class Setting {
	readonly settingEl: HTMLElement;
	readonly infoEl: HTMLElement;
	readonly nameEl: HTMLElement;
	readonly descEl: HTMLElement;
	readonly controlEl: HTMLElement;
	readonly components: unknown[] = [];

	constructor(containerEl: HTMLElement) {
		this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
		this.infoEl = this.settingEl.createDiv({ cls: 'setting-item-info' });
		this.nameEl = this.infoEl.createDiv({ cls: 'setting-item-name' });
		this.descEl = this.infoEl.createDiv({ cls: 'setting-item-description' });
		this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
	}

	setName(name: string | DocumentFragment): this {
		setElementContent(this.nameEl, name);
		return this;
	}

	setDesc(desc: string | DocumentFragment): this {
		setElementContent(this.descEl, desc);
		this.descEl.toggle(typeof desc === 'string' ? desc.length > 0 : true);
		return this;
	}

	setClass(cls: string): this {
		this.settingEl.addClasses(cls.split(/\s+/).filter(Boolean));
		return this;
	}

	setTooltip(tooltip: string): this {
		this.settingEl.setAttribute('aria-label', tooltip);
		return this;
	}

	setHeading(): this {
		this.settingEl.addClass('setting-item-heading');
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.settingEl.toggleClass('is-disabled', disabled);
		return this;
	}

	addButton(callback: (component: ButtonComponent) => unknown): this {
		const component = new ButtonComponent(this.controlEl);
		this.components.push(component);
		callback(component);
		return this;
	}

	addExtraButton(callback: (component: ExtraButtonComponent) => unknown): this {
		const component = new ExtraButtonComponent(this.controlEl);
		this.components.push(component);
		callback(component);
		return this;
	}

	addToggle(callback: (component: ToggleComponent) => unknown): this {
		const component = new ToggleComponent(this.controlEl);
		this.components.push(component);
		callback(component);
		return this;
	}

	addText(callback: (component: TextComponent) => unknown): this {
		const component = new TextComponent(this.controlEl);
		this.components.push(component);
		callback(component);
		return this;
	}

	addTextArea(callback: (component: TextAreaComponent) => unknown): this {
		const component = new TextAreaComponent(this.controlEl);
		this.components.push(component);
		callback(component);
		return this;
	}

	addDropdown(callback: (component: DropdownComponent) => unknown): this {
		const component = new DropdownComponent(this.controlEl);
		this.components.push(component);
		callback(component);
		return this;
	}

	then(callback: (setting: this) => unknown): this {
		callback(this);
		return this;
	}

	clear(): this {
		this.settingEl.empty();
		return this;
	}
}

export class Modal {
	app: unknown;
	containerEl: HTMLElement;
	modalEl: HTMLElement;
	titleEl: HTMLElement;
	contentEl: HTMLElement;
	shouldRestoreSelection = false;

	constructor(app: unknown) {
		this.app = app;
		const doc = typeof document !== 'undefined' ? document : null;
		if (!doc) {
			throw new Error('Modal mock requires a DOM-enabled test environment');
		}
		this.containerEl = doc.createElement('div');
		this.modalEl = this.containerEl.createDiv({ cls: 'modal' });
		this.titleEl = this.modalEl.createDiv({ cls: 'modal-title' });
		this.contentEl = this.modalEl.createDiv({ cls: 'modal-content' });
	}

	open(): void {
		document.body.appendChild(this.containerEl);
		void this.onOpen();
	}

	close(): void {
		this.onClose();
		this.containerEl.detach();
	}

	onOpen(): Promise<void> | void {}

	onClose(): void {}

	setTitle(title: string): this {
		this.titleEl.setText(title);
		return this;
	}

	setContent(content: string | DocumentFragment): this {
		setElementContent(this.contentEl, content);
		return this;
	}

	setCloseCallback(_callback: () => unknown): this {
		return this;
	}
}

export class PluginSettingTab {
	app: unknown;
	plugin: unknown;
	containerEl: HTMLElement;

	constructor(app: unknown, plugin: unknown) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = typeof document !== 'undefined' ? document.createElement('div') : ({} as HTMLElement);
	}

	display(): void {}

	hide(): void {}
}

export class Plugin {}

export const Platform = {
	isDesktopApp: true,
};

export async function requestUrl(): Promise<never> {
	throw new Error('requestUrl mock not implemented for this test');
}
