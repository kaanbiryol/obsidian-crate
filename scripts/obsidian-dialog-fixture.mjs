// Synthetic native Obsidian host for plugin dialog layout checks.
// Production components and styles are bundled by each browser harness.
export const obsidianDomHelpers = `    HTMLElement.prototype.createEl = function(tag, options = {}) {
      const el = document.createElement(tag); el.className = options.cls ?? ''; el.textContent = options.text ?? '';
      for (const [key,value] of Object.entries(options.attr ?? {})) el.setAttribute(key,value);
      this.append(el); return el;
    };
    HTMLElement.prototype.createSpan = function(options) { return this.createEl('span',options); };
    HTMLElement.prototype.createDiv = function(options) { return this.createEl('div',options); };
    HTMLElement.prototype.addClass = function(...names) { this.classList.add(...names); };
    HTMLElement.prototype.setText = function(text) { this.textContent = text; };
    HTMLElement.prototype.empty = function() { this.replaceChildren(); };
    HTMLElement.prototype.toggleClass = function(name, value) { this.classList.toggle(name, value); };
    HTMLElement.prototype.hide = function() { this.style.display = 'none'; };
    HTMLElement.prototype.show = function() { this.style.removeProperty('display'); };
    Object.defineProperty(HTMLElement.prototype,'win',{get:()=>window});
    HTMLElement.prototype.removeClass = function(...names) { this.classList.remove(...names); };
    HTMLElement.prototype.appendText = function(text) { this.append(text); };
`;

export const obsidianDialogModule = `      export function setIcon(el) {
        const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('viewBox','0 0 24 24');
        svg.setAttribute('width','18');svg.setAttribute('height','18');svg.setAttribute('stroke','currentColor');
        const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d','M6 6l12 12M18 6 6 18');svg.append(path);el.append(svg);
      }
      export class Setting {
        constructor(el) {
          this.settingEl=el.createDiv({cls:'setting-item'});
          this.infoEl=this.settingEl.createDiv({cls:'setting-item-info'});
          this.nameEl=this.infoEl.createDiv({cls:'setting-item-name'});this.descEl=this.infoEl.createDiv({cls:'setting-item-description'});
          this.controlEl=this.settingEl.createDiv({cls:'setting-item-control'});
        }
        setName(text){this.nameEl.textContent=text;return this;}
        setDesc(text){this.descEl.textContent=text;return this;}
        setClass(name){this.settingEl.classList.add(name);return this;}
        setHeading(){this.settingEl.classList.add('setting-item-heading');return this;}
        addTextArea(build){return this.addText(build,'textarea');}
        addText(build, tag='input'){
          const input=this.controlEl.createEl(tag);
          const api={inputEl:input,setValue:v=>{input.value=v;return api;},setPlaceholder:v=>{input.placeholder=v;return api;},onChange:fn=>{input.oninput=()=>fn(input.value);return api;}};
          build(api);return this;
        }
        addToggle(build){
          this.settingEl.classList.add('mod-toggle');
          const input=this.controlEl.createEl('input',{attr:{type:'checkbox'}});
          const api={setValue:v=>{input.checked=v;return api;},onChange:fn=>{input.onchange=()=>fn(input.checked);return api;}};
          build(api);return this;
        }
        addButton(build){
          this.settingEl.classList.add('mod-action');
          const button=this.controlEl.createEl('button');
          const api={buttonEl:button,setButtonText:v=>{button.textContent=v;return api;},setDisabled:v=>{button.disabled=v;return api;},
            onClick:fn=>{button.onclick=fn;return api;},setCta:()=>{button.classList.add('mod-cta');return api;},setDestructive:()=>{button.classList.add('mod-warning');return api;}};
          build(api);return this;
        }
      }

      export class Notice { constructor(message) { window.notices ??= []; window.notices.push(message); } }
      export class Modal {
        constructor(app) {
          this.app = app;
          this.containerEl = document.body.createDiv({cls:'modal-container'});
          this.modalEl = this.containerEl.createDiv({cls:'modal'});
          this.titleEl = this.modalEl.createDiv({cls:'modal-header'}).createEl('h2');
          this.modalEl.createDiv({cls:'modal-close-button'});
          this.contentEl = this.modalEl.createDiv({cls:'modal-content'});
          window.currentModal = this;
        }
        setTitle(title) { this.titleEl.setText(title); this.modalEl.setAttribute('role','dialog'); this.modalEl.setAttribute('aria-label',title); }
        open() { this.onOpen(); }
        close() { this.onClose(); this.containerEl.remove(); }
      }
`;

export const hostStyles = `
  :root{--background-primary:#fff;--background-secondary:#f5f5f5;--background-modifier-border:#ddd;--background-modifier-hover:#eee;--text-normal:#242424;--text-muted:#666;--text-accent:#7057b8;--interactive-accent:#7057b8;--text-on-accent:white;--interactive-normal:#eee;--text-success:#26763d;--text-error:#c33636;--font-ui-small:14px;--font-ui-smaller:12px;--font-ui-medium:16px;--radius-m:8px;--radius-s:4px;--font-interface:system-ui;--font-monospace:monospace}
  .theme-dark{--background-primary:#1e1e1e;--background-secondary:#262626;--background-modifier-border:#393939;--background-modifier-hover:#303030;--text-normal:#ddd;--text-muted:#aaa;--interactive-normal:#292929;--text-success:#87c693;--text-error:#ed9696}
  *{box-sizing:border-box}body{margin:0;background:var(--background-secondary);color:var(--text-normal);font:16px system-ui;display:flex;align-items:center;justify-content:center;height:100dvh}
  button,input,textarea{font:inherit;color:inherit;border:1px solid var(--background-modifier-border);background:var(--interactive-normal);padding:8px 12px;border-radius:6px}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}
  .modal:not(.mod-settings) .setting-item:not(.setting-item-heading):where(:not(.setting-group *)){padding:16px 0;border-top:1px solid var(--background-modifier-border)}
  .modal{background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:14px}
  .setting-item{display:flex;align-items:center;padding:18px 0;border-top:1px solid var(--background-modifier-border)}.setting-item-info{flex:1 1 auto;margin-right:16px}.setting-item-control{display:flex;flex:1 0 auto;justify-content:flex-end;align-items:center;gap:8px}

.modal-container{display:flex;align-items:center;justify-content:center;height:100dvh;width:100%}
`;
