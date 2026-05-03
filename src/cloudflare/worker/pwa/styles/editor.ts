export const EDITOR_STYLES = `
.pwa-reminder-editor-backdrop{align-items:flex-end;justify-content:center;padding:0 18px var(--keyboard-offset);background:rgba(0,0,0,.56);backdrop-filter:blur(8px);transition:padding-bottom .22s cubic-bezier(.32,.72,0,1)}
.modal-card.pwa-reminder-editor{width:min(1120px,calc(100vw - 36px));max-height:calc(var(--keyboard-usable-height,100dvh) - 72px);overflow:auto;background:#1f1f1f;border:1px solid rgba(255,255,255,.08);border-bottom:none;border-radius:24px 24px 0 0;padding:12px 44px calc(76px + env(safe-area-inset-bottom));box-shadow:0 -1px 0 rgba(255,255,255,.035);backface-visibility:hidden;transform:translate3d(0,0,0);will-change:transform;animation:pwa-sheet-in .36s cubic-bezier(.32,.72,0,1) both;display:flex;flex-direction:column}
.modal-card.pwa-reminder-editor.is-switching-out{pointer-events:none;animation:pwa-sheet-out .22s cubic-bezier(.4,0,1,1) forwards}
.modal-card.pwa-reminder-editor::before{content:"";display:block;width:40px;height:5px;margin:0 auto 18px;border-radius:999px;background:rgba(255,255,255,.16)}
.pwa-reminder-editor .modal-form{gap:0;display:flex;flex:1;min-height:0;flex-direction:column}
.pwa-editor-header{display:grid;grid-template-columns:64px minmax(0,1fr) 64px;align-items:center;margin-bottom:112px}
.pwa-editor-header__side{display:flex;align-items:center;justify-content:flex-start}
.pwa-editor-header__side--right{justify-content:flex-end}
.pwa-editor-title{margin:0;text-align:center;font-size:20px;font-weight:600;line-height:1.2;letter-spacing:0;color:var(--text-normal)}
.pwa-editor-icon-button{width:44px;height:44px;min-width:44px;border-radius:50%;display:grid;place-items:center;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.055);color:var(--text-muted);padding:0}
.pwa-editor-icon-button svg{width:22px;height:22px}
.pwa-editor-icon-button--danger{background:rgba(239,68,68,.08);border-color:rgba(239,68,68,.16);color:#ff4d4d}
.pwa-editor-icon-button--danger.is-active{background:rgba(239,68,68,.14);border-color:rgba(239,68,68,.28)}
.pwa-editor-icon-button--save{background:#7c3aed;border-color:rgba(124,58,237,.55);color:white;box-shadow:0 6px 18px rgba(124,58,237,.34)}
.pwa-editor-icon-button--save:disabled{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.08);color:var(--text-faint);box-shadow:none}
.pwa-editor-card{position:relative;display:flex;flex-direction:column;min-height:420px;padding:24px 30px 28px;border-radius:14px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.055);box-shadow:0 2px 8px rgba(0,0,0,.04)}
.pwa-editor-title-input,.pwa-editor-description-input{display:block;width:100%;padding:0;margin:0;background:transparent;border:none;outline:none;box-shadow:none;color:var(--text-normal);font-family:inherit;resize:none;-webkit-appearance:none}
.pwa-editor-title-input{min-height:42px;max-height:120px;font-size:20px;font-weight:500;line-height:1.35;letter-spacing:0;overflow:auto}
.pwa-editor-title-rich-input{white-space:pre-wrap;word-break:break-word;caret-color:var(--text-normal)}
.pwa-editor-title-rich-input:empty::before{content:attr(data-placeholder);color:rgba(255,255,255,.32);pointer-events:none}
.pwa-editor-title-rich-input .rich-text-chip{line-height:1.45}
.pwa-editor-description-input{flex:1;min-height:78px;max-height:260px;font-size:13px;font-weight:500;line-height:1.55;color:rgba(255,255,255,.43);overflow:auto}
.pwa-editor-title-input::placeholder,.pwa-editor-description-input::placeholder{color:rgba(255,255,255,.32)}
.pwa-editor-divider{height:1px;background:rgba(255,255,255,.055);margin:18px 0 20px}
.pwa-editor-chip-row{display:flex;align-items:center;flex-wrap:wrap;gap:20px;margin-top:34px;padding-top:28px;border-top:1px solid rgba(255,255,255,.055)}
.pwa-editor-chip{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:44px;min-width:44px;max-width:100%;padding:0 14px;border-radius:14px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.07);color:var(--text-muted);font-size:13px;font-weight:600;line-height:1}
.pwa-editor-chip span{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pwa-editor-chip svg{width:16px;height:16px;opacity:.9}
.pwa-editor-chip.is-active{background:rgba(124,58,237,.16);border-color:rgba(124,58,237,.38);color:#8b5cf6}
.pwa-editor-chip.is-important{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.28);color:#ff4d4d}
.pwa-editor-chip--icon{width:44px;padding:0}
.pwa-reminder-editor .composer-panel{margin-top:18px;padding:14px;border-radius:14px;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.055)}
.pwa-reminder-editor .delete-confirm{margin-top:18px}
.pwa-picker-sheet{width:min(620px,calc(100vw - 36px));max-height:calc(var(--keyboard-usable-height,100dvh) - 88px);overflow:auto;background:#1f1f1f;border:1px solid rgba(255,255,255,.08);border-bottom:none;border-radius:24px 24px 0 0;padding:12px 24px calc(24px + env(safe-area-inset-bottom));box-shadow:0 -1px 0 rgba(255,255,255,.035);backface-visibility:hidden;transform:translate3d(0,0,0);will-change:transform;animation:pwa-sheet-in .36s cubic-bezier(.32,.72,0,1) both}
.pwa-picker-sheet.is-switching-out{pointer-events:none;animation:pwa-sheet-out .22s cubic-bezier(.4,0,1,1) forwards}
.pwa-picker-sheet::before{content:"";display:block;width:40px;height:5px;margin:0 auto 16px;border-radius:999px;background:rgba(255,255,255,.16)}
.pwa-picker-header{display:grid;grid-template-columns:44px minmax(0,1fr) 44px;align-items:center;gap:12px;margin-bottom:18px}
.pwa-picker-header h3{margin:0;text-align:center;font-size:18px;font-weight:600;line-height:1.2;letter-spacing:0;color:var(--text-normal)}
.pwa-picker-icon-button{width:44px;height:44px;min-width:44px;border-radius:50%;display:grid;place-items:center;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.055);color:var(--text-muted);padding:0}
.pwa-picker-icon-button--done{background:#7c3aed;border-color:rgba(124,58,237,.55);color:white;box-shadow:0 6px 18px rgba(124,58,237,.28)}
.pwa-picker-content{display:flex;flex-direction:column;gap:14px}
.pwa-picker-presets,.pwa-project-list{display:flex;flex-direction:column;gap:8px}
.pwa-project-list{max-height:280px;overflow:auto;padding-right:2px}
.pwa-picker-option,.pwa-project-option{width:100%;height:48px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-radius:14px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.07);color:var(--text-normal);font-size:14px;font-weight:600;padding:0 14px;text-align:left;transition:transform 160ms ease,background 180ms ease,border-color 180ms ease,color 180ms ease}
.pwa-picker-option svg,.pwa-project-option svg{width:16px;height:16px;opacity:.9;flex:0 0 auto}
.pwa-picker-option.is-danger{background:rgba(239,68,68,.08);border-color:rgba(239,68,68,.16);color:#ff8f8f}
.pwa-project-option.is-active{background:rgba(124,58,237,.16);border-color:rgba(124,58,237,.38);color:#a78bfa}
.pwa-project-option span{display:flex;align-items:center;gap:9px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pwa-project-picker-sheet{width:min(760px,calc(100vw - 36px));padding:12px 22px calc(22px + env(safe-area-inset-bottom))}
.pwa-project-picker-sheet::before{display:none}
.pwa-project-picker-sheet .pwa-picker-content{gap:0}
.pwa-project-picker-header{grid-template-columns:48px minmax(0,1fr) 48px;margin-bottom:34px}
.pwa-project-picker-header h3{font-size:20px;font-weight:700}
.pwa-project-picker-back{width:46px;height:46px;min-width:46px;border-radius:50%;background:rgba(255,255,255,.055);color:var(--text-muted)}
.pwa-project-picker-back svg{width:22px;height:22px}
.pwa-project-picker-sheet .pwa-project-list{gap:8px;max-height:calc(70dvh - 100px);padding-right:0}
.pwa-project-picker-sheet .pwa-project-option{min-height:54px;height:auto;padding:0 22px;border-radius:13px;background:#232323;border-color:rgba(255,255,255,.065);box-shadow:0 2px 8px rgba(0,0,0,.06);color:var(--text-normal);font-size:14px;font-weight:600}
.pwa-project-picker-sheet .pwa-project-option.is-active{background:#232323;border-color:#86b7f5;box-shadow:0 0 0 1px #86b7f5,0 0 10px -6px #86b7f5;color:var(--text-normal)}
.pwa-project-picker-sheet .pwa-project-option svg{width:18px;height:18px;color:#86b7f5;filter:drop-shadow(0 0 6px rgba(134,183,245,.65))}
.pwa-project-option__label{display:flex;align-items:center;gap:14px;min-width:0;overflow:hidden}
.pwa-project-option__name{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pwa-project-dot{position:relative;display:block;width:10px;height:10px;min-width:10px;overflow:visible;border-radius:50%;background:var(--project-color,#a78bfa);box-shadow:0 0 10px rgba(255,255,255,.05)}
.pwa-project-dot::before{content:"";position:absolute;inset:-4px;border-radius:50%;background:var(--project-color,#a78bfa);opacity:.22;filter:blur(2px)}
.pwa-picker-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding-top:4px}
.pwa-picker-field{display:flex;flex-direction:column;gap:8px}
.pwa-picker-field span{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-faint)}
.pwa-picker-field input{width:100%;height:48px;border-radius:14px;border:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.045);color:var(--text-normal);padding:0 12px;outline:none;font-size:16px;font-family:inherit;-webkit-appearance:none}
.pwa-picker-field input:focus{border-color:rgba(124,58,237,.44);box-shadow:0 0 0 3px rgba(124,58,237,.12)}
.pwa-recurrence-picker-sheet{width:min(620px,calc(100vw - 36px))}
.pwa-recurrence-segmented{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;padding:4px;border-radius:14px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.07)}
.pwa-recurrence-segment{height:44px;border-radius:10px;color:var(--text-muted);font-size:13px;font-weight:650;transition:transform 160ms ease,background 180ms ease,color 180ms ease}
.pwa-recurrence-segment.is-active{background:#7c3aed;color:white;box-shadow:0 2px 10px rgba(124,58,237,.24)}
.pwa-recurrence-stepper{display:flex;align-items:center;justify-content:center;gap:10px;min-height:64px;border-radius:14px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.07);color:var(--text-muted);font-size:14px;font-weight:600}
.pwa-recurrence-stepper strong{min-width:36px;text-align:center;color:var(--text-normal);font-size:16px}
.pwa-recurrence-stepper__button{width:44px;height:44px;min-width:44px;border-radius:12px;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.07);color:var(--text-normal);font-size:16px;font-weight:700;transition:transform 160ms ease,background 180ms ease,border-color 180ms ease}
.pwa-recurrence-days{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}
.pwa-recurrence-day{aspect-ratio:1;min-width:0;width:100%;height:auto;border-radius:12px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.07);color:var(--text-muted);font-size:12px;font-weight:700}
.pwa-recurrence-day.is-active{background:#7c3aed;border-color:rgba(124,58,237,.55);color:white}
.pwa-recurrence-time-field{border-radius:14px;background:rgba(255,255,255,.025)}
.pwa-keyboard-open .modal-card.pwa-reminder-editor{height:calc(var(--keyboard-usable-height,100dvh) - 72px);max-height:calc(var(--keyboard-usable-height,100dvh) - 72px);padding-bottom:8px}
.pwa-keyboard-open .pwa-editor-header{margin-bottom:18px}
.pwa-keyboard-open .pwa-editor-card{flex:0 1 auto;min-height:0;padding:16px 18px 18px}
.pwa-keyboard-open .pwa-editor-title-input{max-height:96px}
.pwa-keyboard-open .pwa-editor-description-input{flex:0 1 auto;min-height:42px;max-height:88px}
.pwa-keyboard-open .pwa-editor-divider{margin:12px 0 14px}
.pwa-keyboard-open .pwa-editor-chip-row{flex-wrap:nowrap;gap:8px;margin-top:auto;padding-top:14px;overflow-x:auto;scrollbar-width:none}
.pwa-keyboard-open .pwa-editor-chip-row::-webkit-scrollbar{display:none}
.pwa-keyboard-open .pwa-editor-chip{height:38px;min-width:38px;border-radius:12px;padding:0 10px}
.pwa-keyboard-open .pwa-editor-chip--icon{width:38px;min-width:38px;padding:0;flex:0 0 38px}
.app-header.view-header{position:relative;z-index:20;display:flex;align-items:flex-start;justify-content:space-between;flex-shrink:0}
.app-content.reminders-content{flex:1;min-height:0;position:relative;overflow-y:auto;overflow-x:hidden;overscroll-behavior-y:contain;-webkit-overflow-scrolling:touch;padding:16px 16px calc(var(--reminders-tabbar-overlay,0px) + var(--reminders-fab-gap,24px) + var(--reminders-fab-size,56px) + var(--reminders-safe-area,env(safe-area-inset-bottom)))}
.ios-scroll{scrollbar-width:thin;scrollbar-color:var(--background-modifier-border) transparent;-webkit-overflow-scrolling:touch}
.ios-scroll::-webkit-scrollbar{width:6px;background:transparent}
.ios-scroll::-webkit-scrollbar-track{background:transparent}
.ios-scroll::-webkit-scrollbar-thumb{background:var(--background-modifier-border);border-radius:3px}
.ios-scroll::-webkit-scrollbar-thumb:hover{background:var(--text-faint)}
.pwa-reminders-view .ios-scroll{scrollbar-width:none;overscroll-behavior-y:contain}
.pwa-reminders-view .ios-scroll::-webkit-scrollbar{display:none;width:0;height:0}
.premium-projects-list{display:flex;flex-direction:column;gap:10px}
.premium-project-card{position:relative;width:100%;padding:0;border:none;background:transparent;cursor:pointer;text-align:left;appearance:none;-webkit-appearance:none;outline:none;box-shadow:none;font-family:inherit;color:inherit}
.premium-project-card.project-card{margin:0;background:transparent;border:none;border-radius:0;box-shadow:none}
.premium-project-card:focus{outline:none}
.premium-project-card:active{transform:none}
.premium-project-content{position:relative;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-radius:14px;background:rgba(255,255,255,.015);border:1px solid rgba(255,255,255,.03);box-shadow:0 2px 8px rgba(0,0,0,.04);transition:background 200ms ease-out,border-color 200ms ease-out,transform 200ms ease-out}
.premium-project-card:hover .premium-project-content{background:rgba(255,255,255,.035);border-color:rgba(255,255,255,.06)}
.premium-project-card:active .premium-project-content{transform:scale(.98)}
.premium-project-left{display:flex;align-items:center;gap:12px;flex:1;min-width:0}
.premium-project-accent-wrapper{flex-shrink:0}
.premium-project-accent{width:4px;height:32px;border-radius:2px;transition:box-shadow 300ms ease-out}
.premium-project-card:hover .premium-project-accent{box-shadow:0 0 16px currentColor!important}
.premium-project-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.premium-project-name{font-size:15px;font-weight:600;color:var(--text-normal);line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.premium-project-stats{display:flex;align-items:center;gap:10px}
.premium-project-stat{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:500;color:var(--text-muted)}
.premium-project-stat svg{opacity:.7}
.premium-project-stat-done,.premium-project-stat-complete{color:#22c55e}
.premium-project-stat-done svg,.premium-project-stat-complete svg{opacity:1}
.premium-project-stat-empty{font-size:12px;color:var(--text-faint);font-style:italic}
.premium-project-stat-complete{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:500}
.premium-project-right{display:flex;align-items:center;gap:12px;flex-shrink:0}
.premium-project-progress{display:flex;flex-direction:column;align-items:flex-end;gap:4px;min-width:48px}
.premium-mini-progress{width:48px;height:4px;border-radius:2px;background:rgba(255,255,255,.06);overflow:hidden}
.premium-mini-progress-fill{height:100%;border-radius:2px;transition:width 400ms cubic-bezier(.4,0,.2,1)}
.premium-project-percentage{font-size:11px;font-weight:600;color:var(--text-muted);font-variant-numeric:tabular-nums}
.premium-project-chevron{color:var(--text-faint);opacity:.4;transition:opacity 200ms ease-out,transform 200ms ease-out}
.premium-project-card:hover .premium-project-chevron{opacity:.7;transform:translateX(2px)}
.project-detail-shell{display:flex;flex-direction:column;min-height:100%}
.premium-back-button{display:inline-flex;align-items:center;gap:6px;padding:6px 12px 6px 8px;margin:21px 16px 4px;width:fit-content;flex-shrink:0;font-size:13px;font-weight:500;color:var(--text-muted);cursor:pointer;background:rgba(255,255,255,.015);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);border:1px solid rgba(255,255,255,.04);border-radius:20px;box-shadow:0 2px 8px rgba(0,0,0,.04);transition:color 200ms ease-out,background-color 200ms ease-out,border-color 200ms ease-out,transform 200ms ease-out,box-shadow 200ms ease-out;appearance:none;-webkit-appearance:none;outline:none;font-family:inherit}
.pwa-reminders-view .premium-back-button{margin-top:calc(env(safe-area-inset-top) + 12px)}
.premium-back-button svg{width:16px;height:16px;transition:transform 200ms ease-out}
.premium-back-button:hover{color:var(--text-normal);background:rgba(255,255,255,.025);border-color:rgba(255,255,255,.05);box-shadow:0 4px 12px rgba(0,0,0,.06)}
.premium-back-button:hover svg{transform:translateX(-2px)}
.premium-back-button:active{transform:scale(.96);box-shadow:0 1px 4px rgba(0,0,0,.04)}
.premium-back-button:focus{outline:none}
.premium-back-button:focus-visible{outline:2px solid var(--interactive-accent,#7c3aed);outline-offset:2px}
.project-detail-header{margin:12px 20px 16px}
.project-detail-header-top{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.project-detail-title{font-size:18px;font-weight:700;letter-spacing:-.02em;color:var(--text-normal);margin:0;line-height:1.2;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.project-detail-percentage{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;flex-shrink:0;line-height:1.2}
.project-detail-header-bottom{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px}
.project-detail-stats-text{display:flex;align-items:center;gap:6px}
.project-detail-stat{display:inline-flex;align-items:center;gap:3px;font-size:12px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--text-muted)}
.project-detail-stat svg{opacity:.7}
.project-detail-stat-label{color:var(--text-faint);font-weight:400}
.project-detail-stat-done{color:#22c55e}
.project-detail-stat-done svg{opacity:1}
.project-detail-stat-dot{color:var(--text-faint);font-size:10px;line-height:1}
.project-detail-progress-bar{width:48px;height:4px;border-radius:2px;background:rgba(255,255,255,.06);overflow:hidden;flex-shrink:0}
.project-detail-progress-fill{height:100%;border-radius:2px;transition:width 400ms cubic-bezier(.4,0,.2,1)}
.animated-tab-bar{flex-shrink:0;z-index:40;background:var(--background-primary)}
.animated-tab-bar-bottom{position:fixed;bottom:0;left:0;right:0;border-top:1px solid var(--background-modifier-border);margin-bottom:var(--reminders-tabbar-bottom-offset)}
.pwa-reminders-view.is-fullscreen .animated-tab-bar{background:transparent}
.pwa-reminders-view.is-fullscreen .animated-tab-bar-bottom{position:relative;bottom:auto;left:auto;right:auto;flex-shrink:0;margin-bottom:0;transform:none}`;
