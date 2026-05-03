export const RESPONSIVE_STYLES = `
@keyframes view-slide-forward{from{opacity:0;transform:translate3d(22px,0,0) scale(.992);filter:blur(1px)}to{opacity:1;transform:translate3d(0,0,0) scale(1);filter:blur(0)}}
@keyframes view-slide-backward{from{opacity:0;transform:translate3d(-22px,0,0) scale(.992);filter:blur(1px)}to{opacity:1;transform:translate3d(0,0,0) scale(1);filter:blur(0)}}
@keyframes header-title-in{from{opacity:.35;transform:translate3d(0,6px,0)}to{opacity:1;transform:translate3d(0,0,0)}}
@keyframes tab-active-pop{0%{transform:scale(.96)}60%{transform:scale(1.03)}100%{transform:scale(1)}}
@keyframes pwa-spin{to{transform:rotate(360deg)}}
@keyframes pwa-skeleton-shimmer{0%{background-position:120% 0}100%{background-position:-120% 0}}
@keyframes pwa-update-slide-in{from{opacity:0;transform:translate3d(0,-10px,0)}to{opacity:1;transform:translate3d(0,0,0)}}
@media (prefers-reduced-motion: reduce){
	.view-transition,.app-header__body,.tab-button.is-active,.modal-card,.settings-sheet,.pwa-picker-sheet,.pwa-skeleton-line,.pwa-pull-refresh__glyph svg,.pwa-update-banner{animation:none!important}
	.tab-button,.tab-button__icon,.premium-reminder-content,.fab,.pwa-pull-refresh,.pwa-pull-refresh__glyph{transition:none!important}
}
@keyframes sheet-in{from{translate:0 18px;opacity:.92}to{translate:0 0;opacity:1}}
@keyframes pwa-sheet-in{from{transform:translate3d(0,100%,0)}to{transform:translate3d(0,0,0)}}
@keyframes pwa-sheet-out{from{transform:translate3d(0,0,0)}to{transform:translate3d(0,100%,0)}}
@media (min-width: 760px){
	body{display:block}
	#app{width:100vw;border-left:none;border-right:none;background:var(--background-primary)}
	.pwa-reminders-view .view-header{padding-left:40px!important;padding-right:40px!important}
	.pwa-reminders-view .ios-scroll{padding-left:40px!important;padding-right:40px!important}
	.app-content{padding-left:40px;padding-right:40px}
	.bottom-tabs{left:50%;transform:translateX(-50%);width:min(640px,100vw)}
	.fab{right:18px}
	.toast{left:50%;right:auto;transform:translateX(-50%);width:min(420px,calc(100vw - 24px))}
	.settings-sheet{width:min(640px,calc(100vw - 80px))}
}
@media (max-width: 640px){
	.pwa-reminder-editor-backdrop{align-items:flex-end;padding:0 0 var(--keyboard-offset)}
	.settings-backdrop{align-items:flex-end;padding:0 0 var(--keyboard-offset)}
	.modal-card.pwa-reminder-editor{width:100vw;max-height:calc(var(--keyboard-usable-height,100dvh) - 28px);padding:12px 24px calc(28px + env(safe-area-inset-bottom));border-right:none;border-left:none;border-radius:24px 24px 0 0}
	.pwa-keyboard-open .modal-card.pwa-reminder-editor{height:calc(var(--keyboard-usable-height,100dvh) - 28px);max-height:calc(var(--keyboard-usable-height,100dvh) - 28px);padding-bottom:8px}
	.settings-sheet{width:100vw;max-height:calc(var(--keyboard-usable-height,100dvh) - 28px);border-right:none;border-left:none;border-radius:24px 24px 0 0}
	.modal-card.pwa-reminder-editor::before{margin-bottom:14px}
	.pwa-editor-header{grid-template-columns:56px minmax(0,1fr) 56px;margin-bottom:24px}
	.pwa-editor-icon-button{width:44px;height:44px;min-width:44px}
	.pwa-editor-card{min-height:0;padding:16px 20px 18px}
	.pwa-editor-title-input{font-size:20px;min-height:38px}
	.pwa-editor-description-input{flex:0 1 auto;min-height:52px;max-height:120px}
	.pwa-editor-divider{margin:14px 0 16px}
	.pwa-editor-chip-row{flex-wrap:nowrap;gap:8px;margin-top:18px;padding-top:16px;overflow-x:auto;scrollbar-width:none}
	.pwa-editor-chip-row::-webkit-scrollbar{display:none}
	.pwa-editor-chip{height:38px;min-width:38px;border-radius:12px;padding:0 10px;flex:0 1 auto}
	.pwa-editor-chip:not(.pwa-editor-chip--icon){max-width:calc((100vw - 136px)/2)}
	.pwa-editor-chip--icon{width:38px;min-width:38px;padding:0;flex:0 0 38px}
	.pwa-picker-sheet{width:100vw;max-height:calc(var(--keyboard-usable-height,100dvh) - 28px);padding:12px 24px calc(24px + env(safe-area-inset-bottom));border-right:none;border-left:none;border-radius:24px 24px 0 0}
}
@media (max-height: 900px) and (min-width: 641px){
	.modal-card.pwa-reminder-editor{max-height:calc(var(--keyboard-usable-height,100dvh) - 36px);padding-bottom:calc(32px + env(safe-area-inset-bottom))}
	.pwa-editor-header{margin-bottom:42px}
	.pwa-editor-card{min-height:320px}
	.pwa-editor-chip-row{margin-top:24px;padding-top:20px}
}
@media (max-width: 520px){
	.field-row{grid-template-columns:1fr}
	.composer-panel__grid,.priority-grid,.pwa-picker-fields{grid-template-columns:1fr}
}
@media (max-width: 420px){
	.app-header{padding-left:12px;padding-right:12px}
	.app-header__body h1{font-size:23px}
	.header-meta{font-size:11.5px}
	.project-card__title{font-size:14px}
	.card-title{font-size:14px}
	.card-description{font-size:12px}
	.meta-pill,.tag-pill,.priority-pill{font-size:10.5px}
	.tab-button{font-size:9.5px;min-height:50px}
	.composer-input{font-size:18px;min-height:70px}
	.composer-chip,.preset-chip,.project-choice{font-size:12px}
	.delete-confirm{flex-direction:column}
	.delete-confirm__actions{width:100%;display:grid;grid-template-columns:1fr 1fr}
	.modal-actions{flex-direction:column-reverse;align-items:stretch}
	.modal-actions__primary{display:grid;grid-template-columns:1fr 1fr}
	.settings-panel__row{align-items:flex-start;flex-direction:column}
	.settings-panel__row code{max-width:100%;text-align:left}
}
@media (max-width: 392px){
	:root{--tabbar-h:64px}
	.app-content{padding-left:10px;padding-right:10px}
	.project-card{padding:10px}
	.reminder-card__main{padding:10px}
	.checkbox{width:23px;height:23px;min-width:23px;flex-basis:23px}
	.card-handle{width:26px;height:26px;min-width:26px;flex-basis:26px}
	.card-title{font-size:13.5px}
	.bottom-tabs{padding-left:6px;padding-right:6px}
	.fab{width:46px;height:46px;min-width:46px;right:10px;bottom:calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 10px)}
}
@media (max-width: 420px){
	.pwa-reminders-view .view-header{padding:calc(env(safe-area-inset-top) + 16px) 20px 12px!important}
	.pwa-header-settings-button,.pwa-header-sync-button{width:44px;height:44px;min-width:44px}
	.app-header{padding:calc(env(safe-area-inset-top) + 16px) 20px 12px}
	.app-header__body h1{font-size:28px}
	.header-meta{font-size:14px}
	.card-title,.premium-reminder-title{font-size:14px}
	.card-description,.premium-reminder-description{font-size:12px}
	.meta-pill,.tag-pill,.premium-pill{font-size:11px}
	.tab-button{font-size:13px;min-height:48px}
}
@media (max-width: 392px){
	:root{--tabbar-h:80px}
	.app-content{padding:16px 16px calc(var(--reminders-tabbar-height) + var(--reminders-fab-gap) + var(--reminders-fab-size) + env(safe-area-inset-bottom))}
	.reminder-card__main,.premium-reminder-content{padding:14px 16px}
	.checkbox,.premium-checkbox{width:20px;height:20px;min-width:20px;flex-basis:20px}
	.bottom-tabs{padding:8px 12px calc(8px + env(safe-area-inset-bottom))}
	.fab{right:16px;bottom:calc(var(--reminders-tabbar-height) + var(--reminders-fab-gap) + env(safe-area-inset-bottom));width:56px;height:56px;min-width:56px}
}`;
