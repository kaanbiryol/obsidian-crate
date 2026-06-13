class FakeStyle {
	display = '';
	width = '';
	private readonly properties = new Map<string, string>();

	setProperty(name: string, value: string): void {
		this.properties.set(name, value);
		(this as unknown as Record<string, string>)[name] = value;
	}

	getPropertyValue(name: string): string {
		return this.properties.get(name) ?? (this as unknown as Record<string, string>)[name] ?? '';
	}
}

export class FakeElement {
	readonly tagName: string;
	textContent = '';
	readonly children: FakeElement[] = [];
	readonly classNames = new Set<string>();
	readonly attributes = new Map<string, string>();
	readonly style = new FakeStyle();

	constructor(tagName: string) {
		this.tagName = tagName;
	}

	createEl(tag: string, info?: { text?: string; cls?: string }): FakeElement {
		const child = new FakeElement(tag);
		if (info?.text) {
			child.textContent = info.text;
		}
		if (info?.cls) {
			child.addClasses(info.cls.split(/\s+/).filter(Boolean));
		}
		this.children.push(child);
		return child;
	}

	createDiv(info?: { text?: string; cls?: string }): FakeElement {
		return this.createEl('div', info);
	}

	createSpan(info?: { text?: string; cls?: string }): FakeElement {
		return this.createEl('span', info);
	}

	appendChild(child: FakeElement): FakeElement {
		this.children.push(child);
		return child;
	}

	empty(): void {
		this.children.length = 0;
		this.textContent = '';
	}

	setText(text: string): void {
		this.textContent = text;
	}

	addClass(...classes: string[]): void {
		for (const cls of classes) {
			this.classNames.add(cls);
		}
	}

	addClasses(classes: string[]): void {
		this.addClass(...classes);
	}

	removeClass(...classes: string[]): void {
		for (const cls of classes) {
			this.classNames.delete(cls);
		}
	}

	toggleClass(classes: string | string[], value: boolean): void {
		const resolved = Array.isArray(classes) ? classes : [classes];
		if (value) {
			this.addClasses(resolved);
			return;
		}
		this.removeClass(...resolved);
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	show(): void {
		this.setCssProps({ display: '' });
	}

	hide(): void {
		this.setCssProps({ display: 'none' });
	}

	setCssProps(props: Record<string, string>): void {
		for (const [name, value] of Object.entries(props)) {
			this.style.setProperty(name, value);
		}
	}

	collectText(): string {
		return [this.textContent, ...this.children.map((child) => child.collectText())]
			.filter(Boolean)
			.join(' ');
	}
}

export class MockButtonComponent {
	readonly buttonEl = new FakeElement('button');
	private clickHandler?: (event: MouseEvent) => unknown;

	constructor(containerEl: FakeElement) {
		containerEl.appendChild(this.buttonEl);
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

	setDisabled(disabled: boolean): this {
		this.buttonEl.toggleClass('is-disabled', disabled);
		return this;
	}

	onClick(callback: (event: MouseEvent) => unknown): this {
		this.clickHandler = callback;
		return this;
	}

	click(): void {
		this.clickHandler?.({} as MouseEvent);
	}
}

class FakeTextInput {
	value = '';
	maxLength = 0;
	placeholder = '';
	type = 'text';
	size = 0;
	disabled = false;
	private readonly listeners = new Map<string, Array<(event: Event) => unknown>>();

	addEventListener(type: string, callback: (event: Event) => unknown): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(callback);
		this.listeners.set(type, listeners);
	}

	blur(): void {
		this.dispatchEvent('blur');
	}

	dispatchEvent(type: string, event = {} as Event): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event);
		}
	}
}

export class MockTextComponent {
	readonly inputEl = new FakeTextInput();
	private changeHandler?: (value: string) => unknown;

	setValue(value: string): this {
		this.inputEl.value = value;
		return this;
	}

	setPlaceholder(value: string): this {
		this.inputEl.placeholder = value;
		return this;
	}

	setDisabled(disabled: boolean): this {
		this.inputEl.disabled = disabled;
		return this;
	}

	onChange(callback: (value: string) => unknown): this {
		this.changeHandler = callback;
		return this;
	}

	change(value: string): void {
		this.inputEl.value = value;
		this.changeHandler?.(value);
	}
}

export class MockToggleComponent {
	private changeHandler?: (value: boolean) => unknown;
	value = false;

	setValue(value: boolean): this {
		this.value = value;
		return this;
	}

	onChange(callback: (value: boolean) => unknown): this {
		this.changeHandler = callback;
		return this;
	}

	change(value: boolean): void {
		this.value = value;
		this.changeHandler?.(value);
	}
}

export class MockSetting {
	static instances: MockSetting[] = [];

	readonly settingEl: FakeElement;
	readonly infoEl: FakeElement;
	readonly nameEl: FakeElement;
	readonly descEl: FakeElement;
	readonly controlEl: FakeElement;
	readonly buttons: MockButtonComponent[] = [];
	readonly texts: MockTextComponent[] = [];
	readonly toggles: MockToggleComponent[] = [];

	constructor(containerEl: FakeElement) {
		this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
		this.infoEl = this.settingEl.createDiv({ cls: 'setting-item-info' });
		this.nameEl = this.infoEl.createDiv({ cls: 'setting-item-name' });
		this.descEl = this.infoEl.createDiv({ cls: 'setting-item-description' });
		this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
		MockSetting.instances.push(this);
	}

	setName(name: string): this {
		this.nameEl.setText(name);
		return this;
	}

	setDesc(desc: string): this {
		this.descEl.setText(desc);
		return this;
	}

	setClass(cls: string): this {
		this.settingEl.addClasses(cls.split(/\s+/).filter(Boolean));
		return this;
	}

	setHeading(): this {
		this.settingEl.addClass('setting-item-heading');
		return this;
	}

	addButton(callback: (button: MockButtonComponent) => unknown): this {
		const button = new MockButtonComponent(this.controlEl);
		this.buttons.push(button);
		callback(button);
		return this;
	}

	addText(callback: (text: MockTextComponent) => unknown): this {
		const text = new MockTextComponent();
		this.texts.push(text);
		callback(text);
		return this;
	}

	addToggle(callback: (toggle: MockToggleComponent) => unknown): this {
		const toggle = new MockToggleComponent();
		this.toggles.push(toggle);
		callback(toggle);
		return this;
	}
}

export class MockModal {
	static instances: MockModal[] = [];

	readonly modalEl = new FakeElement('div');
	readonly contentEl = new FakeElement('div');
	readonly titleEl = new FakeElement('div');

	constructor(public readonly app: unknown) {
		this.modalEl.appendChild(this.titleEl);
		this.modalEl.appendChild(this.contentEl);
	}

	open(): void {
		MockModal.instances.push(this);
		void this.onOpen();
	}

	close(): void {
		this.onClose();
	}

	onOpen(): Promise<void> | void {}

	onClose(): void {}

	setTitle(title: string): this {
		this.titleEl.setText(title);
		return this;
	}
}

export const noticeMessages: string[] = [];

export function resetObsidianUiMocks(): void {
	MockModal.instances.length = 0;
	MockSetting.instances.length = 0;
	noticeMessages.length = 0;
}

export function createObsidianUiModule(): Record<string, unknown> {
	return {
		Modal: MockModal,
		Setting: MockSetting,
		ButtonComponent: MockButtonComponent,
		ExtraButtonComponent: MockButtonComponent,
		Notice: class Notice {
			constructor(message?: string) {
				if (message) {
					noticeMessages.push(message);
				}
			}
		},
	};
}
