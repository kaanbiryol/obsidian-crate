export const BASE_STYLES = `:root{
	--bg:#0b0d11;
	--panel:#15171d;
	--panel-2:#1a1d24;
	--panel-3:#222631;
	--line:rgba(255,255,255,.10);
	--line-soft:rgba(255,255,255,.06);
	--text:#f6f7fb;
	--text-muted:#a5abb8;
	--text-faint:#6f7787;
	--accent:#9b7cff;
	--accent-rgb:155,124,255;
	--accent-strong:#8061f2;
	--danger:#f87171;
	--success:#22c55e;
	--shadow:0 16px 38px rgba(0,0,0,.32);
	--radius-xl:22px;
	--radius-lg:16px;
	--radius-md:13px;
	--radius-sm:10px;
	--tabbar-h:70px;
	--keyboard-offset:0px;
	--keyboard-usable-height:100dvh;
	--heroui-primary:263 90% 61%;
	--heroui-secondary:263 90% 61%;
	--heroui-danger:0 100% 65%;
	--heroui-warning:38 92% 55%;
	--heroui-success:142 71% 45%;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;padding:0;background:linear-gradient(180deg,#131820 0%,#0c0f14 44%,#090a0d 100%);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Segoe UI",system-ui,sans-serif;height:100%;overflow:hidden;overscroll-behavior:none;color-scheme:dark}
body{width:100%;min-height:100%;overflow:hidden;touch-action:manipulation}
button,input,textarea,select{font:inherit}
button{cursor:pointer;border:none;background:transparent;color:inherit;touch-action:manipulation;user-select:none;-webkit-user-select:none}
button:disabled{cursor:not-allowed;opacity:.55}
input,textarea,[contenteditable="true"]{user-select:text;-webkit-user-select:text}
:focus-visible{outline:2px solid rgba(var(--accent-rgb),.72);outline-offset:2px}
.flex{display:flex}.inline-flex{display:inline-flex}.flex-col{flex-direction:column}.flex-wrap{flex-wrap:wrap}.flex-1{flex:1 1 0%}.items-center{align-items:center}.justify-center{justify-content:center}.justify-between{justify-content:space-between}.justify-end{justify-content:flex-end}.h-full{height:100%}.h-10{height:2.5rem}.h-auto{height:auto}.w-full{width:100%}.min-w-0{min-width:0}.relative{position:relative}.fixed{position:fixed}.absolute{position:absolute}.inset-0{inset:0}.overflow-hidden{overflow:hidden}.overflow-y-auto{overflow-y:auto}.overflow-y-scroll{overflow-y:scroll}.text-center{text-align:center}.whitespace-nowrap{white-space:nowrap}.bg-transparent{background:transparent}.border-none{border:none}.outline-none{outline:none}.resize-none{resize:none}.rounded-lg{border-radius:8px}.rounded-xl{border-radius:12px}.rounded-2xl{border-radius:16px}.rounded-t-3xl{border-top-left-radius:24px;border-top-right-radius:24px}.px-0{padding-left:0;padding-right:0}.px-5{padding-left:1.25rem;padding-right:1.25rem}.py-0{padding-top:0;padding-bottom:0}.pt-3{padding-top:.75rem}.pt-4{padding-top:1rem}.pb-3{padding-bottom:.75rem}.pb-4{padding-bottom:1rem}.mt-3{margin-top:.75rem}.mt-4{margin-top:1rem}.mt-6{margin-top:1.5rem}.mb-3{margin-bottom:.75rem}.mx-4{margin-left:1rem;margin-right:1rem}.max-w-lg{max-width:32rem}.text-sm{font-size:.875rem}.font-semibold{font-weight:600}.space-y-2>:not([hidden])~:not([hidden]){margin-top:.5rem}.space-y-6>:not([hidden])~:not([hidden]){margin-top:1.5rem}.gap-0{gap:0}.gap-2{gap:.5rem}.w-9{width:2.25rem}.h-9{height:2.25rem}.min-w-9{min-width:2.25rem}.w-16{width:4rem}
.app-shell [data-slot="ripple"],.app-shell [data-ripple="true"],.app-shell .heroui-ripple,.app-shell .nextui-ripple{display:none!important;opacity:0!important}
#app{height:100%;width:100%;max-width:100vw;display:flex;flex-direction:column;overflow:hidden}
.auth-card{max-width:420px;margin:0 auto;padding:24px 20px;min-height:100dvh;display:flex;flex-direction:column;justify-content:center;gap:14px}
.auth-card h1{margin:0;font-size:34px;line-height:1.06;letter-spacing:-.04em}
.auth-card p{margin:0;color:var(--text-muted);line-height:1.5;font-size:15px}
.app-shell{height:100%;display:flex;flex-direction:column;overflow:hidden}
.app-header{padding:calc(env(safe-area-inset-top) + 12px) 14px 11px;position:relative;z-index:20;background:linear-gradient(180deg,rgba(12,15,20,.96),rgba(12,15,20,.90));backdrop-filter:blur(22px);border-bottom:1px solid var(--line-soft);flex-shrink:0}
.app-header__row{display:flex;align-items:center;gap:10px}
.app-header__body{flex:1;min-width:0}
.app-header__body h1{margin:0;font-size:25px;line-height:1.03;letter-spacing:-.045em}
.header-meta{margin-top:5px;display:flex;align-items:center;gap:7px;flex-wrap:wrap;color:var(--text-muted);font-size:12px;line-height:1.35}
.overdue-pill{display:inline-flex;align-items:center;justify-content:center;padding:3px 8px;border-radius:999px;background:rgba(248,113,113,.13);color:#ff9a9a;font-weight:760;font-size:10.5px;border:1px solid rgba(248,113,113,.22)}
.app-content{flex:1;position:relative;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior-y:contain;padding:10px 12px calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 18px)}
.app-content__inner{display:flex;flex-direction:column;min-height:100%}
.pull-indicator{position:absolute;left:0;right:0;top:0;height:0;opacity:0;pointer-events:none;display:flex;justify-content:center;align-items:flex-end}
.pull-indicator__inner{display:flex;flex-direction:column;align-items:center;gap:4px;color:var(--accent)}
.pull-indicator__glyph{width:18px;height:18px}
.pull-indicator__glyph svg{width:18px;height:18px;display:block}
.pull-indicator__label{font-size:11px;font-weight:700;color:var(--text-muted)}
.empty-state,.loading-card{margin-top:18px;padding:18px 15px;border-radius:var(--radius-lg);background:rgba(255,255,255,.045);border:1px solid var(--line-soft);text-align:center}
.empty-state h2,.loading-card{font-size:18px}
.empty-state p{margin:10px 0 0;color:var(--text-muted)}
.project-card,.reminder-card,.auth-card,.modal-card,.loading-card,.empty-state{box-shadow:var(--shadow)}
.project-card{display:block;width:100%;min-width:0;background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.035));border:1px solid var(--line-soft);border-radius:14px;padding:11px;margin-bottom:8px;text-align:left;color:inherit;transition:transform .16s ease,border-color .16s ease,background .16s ease}
.project-card:active,.reminder-card:active{transform:scale(.992)}
.project-card__row{display:flex;align-items:center;justify-content:space-between;gap:14px}
.project-card__left{display:flex;align-items:center;gap:12px;min-width:0}
.project-card__icon{width:32px;height:32px;border-radius:10px;background:rgba(var(--project-rgb,155,124,255),.14);color:var(--project-color,var(--accent));display:grid;place-items:center;flex:0 0 32px}
.project-card__icon svg,.project-card__chevron svg{width:18px;height:18px;display:block}
.project-card__title{font-size:15px;font-weight:700;letter-spacing:-.02em}
.project-card__meta{margin-top:3px;color:var(--text-muted);font-size:12px}
.project-card__chevron{color:var(--text-faint);flex:0 0 auto}
.reminders-stack{display:flex;flex-direction:column;gap:8px}
.reorder-list{display:flex;flex-direction:column;gap:8px}
.reminder-card{background:linear-gradient(180deg,rgba(255,255,255,.060),rgba(255,255,255,.038));border:1px solid var(--line-soft);border-radius:14px;overflow:hidden;transition:transform .16s ease,border-color .16s ease,background .16s ease}
.reminder-card.is-priority{border-color:rgba(248,113,113,.18);box-shadow:inset 3px 0 0 rgba(248,113,113,.68),var(--shadow)}
.reminder-card.is-completed{opacity:.72}
.reminder-card__main{display:flex;align-items:flex-start;gap:10px;padding:10px 11px}
.checkbox{width:24px;height:24px;min-width:24px;flex:0 0 24px;border-radius:999px;border:2px solid rgba(255,255,255,.20);background:rgba(255,255,255,.02);color:white;display:grid;place-items:center;margin-top:1px}
.checkbox.is-checked{background:var(--success);border-color:var(--success)}
.checkbox svg{width:14px;height:14px}
.card-body{display:block;flex:1;min-width:0;background:none;border:none;padding:0;color:inherit;text-align:left}
.card-title-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:8px}
.card-title{font-size:14.5px;font-weight:700;line-height:1.26;letter-spacing:-.025em;word-break:break-word;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.is-completed .card-title{text-decoration:line-through;color:var(--text-muted)}
.card-description{margin-top:5px;color:var(--text-muted);line-height:1.38;font-size:12.5px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.card-pills{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}
.meta-pill,.tag-pill,.priority-pill{display:inline-flex;align-items:center;gap:5px;min-height:22px;padding:3px 7px;border-radius:8px;font-size:10.5px;font-weight:680;border:1px solid rgba(255,255,255,.08)}
.meta-pill{background:rgba(255,255,255,.05);color:var(--text-muted)}
.meta-pill.is-overdue{background:rgba(248,113,113,.12);border-color:rgba(248,113,113,.28);color:#ff9a9a}
.tag-pill{background:rgba(var(--pill-rgb),.10);border-color:rgba(var(--pill-rgb),.28);color:var(--pill-color)}
.priority-pill{background:rgba(248,113,113,.10);border-color:rgba(248,113,113,.18);color:#ff9a9a;text-transform:uppercase;font-size:10px;letter-spacing:.08em}
.meta-pill svg,.tag-pill svg,.card-handle svg,.tab-button__icon svg,.icon-button svg,.fab svg,.composer-chip svg{width:14px;height:14px;display:block}
.card-handle{width:28px;height:28px;min-width:28px;flex:0 0 28px;border:none;background:rgba(255,255,255,.045);border-radius:10px;color:var(--text-faint);display:grid;place-items:center;touch-action:none}
.completed-section{margin-top:6px}
.completed-toggle{width:100%;display:flex;align-items:center;justify-content:space-between;background:none;border:none;color:var(--text-muted);padding:7px 2px 2px;font-size:12.5px;font-weight:650}
.chevron{font-size:18px;line-height:1;transform:rotate(0deg);transition:transform .16s ease}
.chevron.is-open{transform:rotate(180deg)}
.completed-list{display:flex;flex-direction:column;gap:8px;padding-top:8px}
.date-group{margin-bottom:15px}
.date-group__title{margin:0 0 8px;padding-left:4px;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--text-faint)}
.bottom-tabs{position:fixed;left:0;right:0;bottom:0;z-index:25;padding:7px 8px calc(7px + env(safe-area-inset-bottom));background:rgba(10,12,16,.94);backdrop-filter:blur(24px);border-top:1px solid var(--line-soft);display:grid;grid-template-columns:repeat(4,1fr);gap:3px}
.tab-button{border:none;background:none;border-radius:13px;padding:6px 4px 4px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;color:var(--text-faint);font-size:10px;font-weight:700;min-height:52px;min-width:0}
.tab-button:focus,.tab-button:focus-visible{outline:none;box-shadow:none}
.tab-button__icon{width:24px;height:24px;border-radius:999px;display:grid;place-items:center;transition:background .16s ease,color .16s ease,transform .16s ease}
.tab-button.is-active{background:transparent;color:var(--accent)}
.tab-button.is-active .tab-button__icon{background:rgba(var(--accent-rgb),.15);transform:translateY(-1px)}
.fab{position:fixed;right:14px;bottom:calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 13px);z-index:24;width:48px;height:48px;min-width:48px;border:none;border-radius:999px;background:linear-gradient(135deg,#a991ff,#8061f2 62%,#6847dc);color:white;box-shadow:0 12px 24px rgba(88,67,190,.36),0 0 0 1px rgba(255,255,255,.10) inset}
.fab svg{width:22px;height:22px;margin:0 auto}
.icon-button,.secondary-button,.primary-button{border:none}
.icon-button{width:34px;height:34px;min-width:34px;border-radius:12px;background:rgba(255,255,255,.055);color:var(--text);display:grid;place-items:center}
.icon-button.is-active{background:rgba(var(--accent-rgb),.16);color:var(--accent)}
.primary-button,.secondary-button{border-radius:12px;padding:10px 14px;font-weight:740;font-size:13.5px;min-height:44px}
.primary-button{background:var(--accent-strong);color:white}
.secondary-button{background:rgba(255,255,255,.06);color:var(--text)}
.secondary-button.is-danger{background:rgba(248,113,113,.12);color:#ff9a9a}
.modal-backdrop{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.62);backdrop-filter:blur(12px);display:flex;align-items:flex-end;justify-content:center;padding:0 0 var(--keyboard-offset)}
.modal-card{width:min(640px,100%);max-height:calc(100dvh - 8px);overflow:auto;background:#15171d;border:1px solid var(--line);border-radius:22px 22px 0 0;padding:9px 13px calc(15px + env(safe-area-inset-bottom));animation:sheet-in .22s cubic-bezier(.2,.8,.2,1)}
.modal-handle{width:38px;height:4px;border-radius:999px;background:rgba(255,255,255,.18);margin:0 auto 14px}
.modal-form{display:flex;flex-direction:column;gap:12px}
.modal-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.modal-header h2{margin:0;font-size:19px;letter-spacing:-.03em}
.modal-subtitle{margin:5px 0 0;color:var(--text-muted);line-height:1.42;font-size:12.5px;max-width:34ch}
.composer-surface{padding:12px;border-radius:16px;background:linear-gradient(180deg,rgba(255,255,255,.060),rgba(255,255,255,.035));border:1px solid var(--line-soft)}
.composer-input-wrap{display:flex;flex-direction:column;gap:8px}
.composer-input__label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-faint)}
.composer-input{width:100%;border:none;background:transparent;color:var(--text);outline:none;padding:0;margin:0;font-size:19px;line-height:1.32;letter-spacing:-.03em;resize:none;min-height:74px}
.composer-input::placeholder{color:#7f7f88}
.composer-hint{margin:10px 0 0;color:var(--text-muted);font-size:12.5px;line-height:1.45}
.composer-toolbar{display:flex;flex-wrap:wrap;gap:7px;margin-top:11px}
.composer-chip{border:none;border-radius:999px;padding:8px 10px;background:rgba(255,255,255,.06);color:var(--text-muted);display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:720;min-height:34px}
.composer-chip.is-active{background:rgba(var(--accent-rgb),.16);color:var(--text);box-shadow:inset 0 0 0 1px rgba(var(--accent-rgb),.32)}
.composer-chip.is-important{background:rgba(248,113,113,.12);color:#ff9a9a;box-shadow:inset 0 0 0 1px rgba(248,113,113,.18)}
.composer-panel{padding:12px;border-radius:15px;background:rgba(255,255,255,.035);border:1px solid var(--line-soft)}
.composer-panel__header{margin-bottom:10px}
.composer-panel__header h3{margin:0;font-size:15px;letter-spacing:-.02em}
.composer-panel__header p{margin:5px 0 0;color:var(--text-muted);font-size:12.5px;line-height:1.45}
.composer-presets{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:11px}
.preset-chip{border:none;border-radius:999px;padding:8px 10px;background:rgba(255,255,255,.06);color:var(--text);font-size:12px;font-weight:720;min-height:34px}
.preset-chip.is-danger{background:rgba(248,113,113,.12);color:#ff9a9a}
.composer-panel__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.field{display:flex;flex-direction:column;gap:8px}
.field span{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-faint)}
.field input,.field textarea,.field select{width:100%;border-radius:12px;border:1px solid var(--line-soft);background:#1d212b;color:var(--text);padding:10px 11px;outline:none;font-size:16px}
.field textarea{resize:vertical;min-height:88px}
.field--dense input,.field--dense textarea{background:rgba(255,255,255,.05)}
.field-row{display:grid;grid-template-columns:minmax(0,1fr) 112px;gap:10px}
.project-choice-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;max-height:164px;overflow:auto}
.project-choice{border:none;border-radius:999px;padding:8px 10px;background:rgba(255,255,255,.06);color:var(--text-muted);font-size:12px;font-weight:720}
.project-choice.is-active{background:rgba(var(--accent-rgb),.16);color:var(--text);box-shadow:inset 0 0 0 1px rgba(var(--accent-rgb),.32)}
.priority-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.priority-card{border:none;border-radius:14px;padding:12px;background:rgba(255,255,255,.05);color:var(--text-muted);display:flex;flex-direction:column;align-items:flex-start;gap:4px;text-align:left}
.priority-card strong{font-size:14px;color:var(--text)}
.priority-card span{font-size:12.5px;line-height:1.4}
.priority-card.is-active{background:rgba(var(--accent-rgb),.16);box-shadow:inset 0 0 0 1px rgba(var(--accent-rgb),.32)}
.priority-card--important.is-active{background:rgba(248,113,113,.12);box-shadow:inset 0 0 0 1px rgba(248,113,113,.24)}
.delete-confirm{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:12px;border-radius:15px;background:rgba(248,113,113,.10);border:1px solid rgba(248,113,113,.18)}
.delete-confirm strong{display:block;font-size:14px}
.delete-confirm p{margin:5px 0 0;color:#f7b0b0;font-size:12.5px;line-height:1.45}
.delete-confirm__actions{display:flex;gap:8px;flex-shrink:0}
.modal-actions{position:sticky;bottom:calc(env(safe-area-inset-bottom) * -1);display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:1px;padding-top:11px;padding-bottom:2px;background:linear-gradient(180deg,rgba(21,23,29,0),rgba(21,23,29,.92) 20px,#15171d 44px)}
.modal-actions__primary{display:flex;gap:8px}
.toast{position:fixed;left:12px;right:12px;bottom:calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 14px);z-index:45;padding:10px 12px;border-radius:13px;background:#20242e;color:white;border:1px solid var(--line);box-shadow:var(--shadow);font-size:12.5px}
.toast.is-success{background:rgba(34,197,94,.16);border-color:rgba(34,197,94,.3)}
.toast.is-error{background:rgba(248,113,113,.16);border-color:rgba(248,113,113,.3)}
.toast.is-info{background:rgba(59,130,246,.16);border-color:rgba(59,130,246,.3)}
.settings-backdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:flex-end;justify-content:center;padding:0 18px var(--keyboard-offset);background:rgba(0,0,0,.56);backdrop-filter:blur(8px);transition:padding-bottom .22s cubic-bezier(.32,.72,0,1)}
.settings-sheet{position:relative;width:min(640px,calc(100vw - 36px));max-height:calc(var(--keyboard-usable-height,100dvh) - 72px);overflow:auto;background:var(--panel);border:1px solid var(--line);border-bottom:none;border-radius:24px 24px 0 0;padding:9px 14px calc(15px + env(safe-area-inset-bottom));box-shadow:var(--shadow);animation:pwa-sheet-in .36s cubic-bezier(.32,.72,0,1) both}
.settings-handle{width:38px;height:4px;border-radius:999px;background:rgba(255,255,255,.18);margin:0 auto 12px}
.settings-sheet__header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,.06)}
.settings-sheet__header h2{margin:0;font-size:18px;letter-spacing:-.02em}
.settings-sheet__header p{margin:6px 0 0;color:var(--text-muted);line-height:1.45;font-size:12.5px}
.settings-panel{padding:0;border-radius:0;background:none;border:none}
.settings-panel__section+.settings-panel__section{margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,.06)}
.settings-panel__title{font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--text-faint);margin-bottom:10px}
.settings-panel__row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
.settings-panel__row:last-child{margin-bottom:0}
.settings-panel__row code{max-width:55%;overflow:auto;font-size:12px;color:var(--text-muted);text-align:right}
.settings-panel__hint{margin:8px 0 0;color:var(--text-muted);line-height:1.45;font-size:13px}
.settings-panel__actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}
.placeholder-card{min-height:58px;background:rgba(var(--accent-rgb),.08);border:1px dashed rgba(var(--accent-rgb),.35)}
.is-dragging{opacity:.98;transform:scale(1.01);box-shadow:0 18px 44px rgba(0,0,0,.45)}
`;
