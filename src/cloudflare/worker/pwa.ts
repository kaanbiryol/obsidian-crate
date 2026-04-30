import { PWA_CLIENT_JS } from './pwa-client-bundle.gen';
import { PWA_ASSET_VERSION } from './pwa-version.gen';

const PWA_START_PARAM_KEYS = ['token', 'folder', 'upcomingDays', 'allDayTime', 'project', 'debugSafeArea'] as const;

function pwaStartSearchFromUrl(requestUrl?: string): string {
	if (!requestUrl) return '';

	const source = new URL(requestUrl).searchParams;
	const params = new URLSearchParams();
	for (const key of PWA_START_PARAM_KEYS) {
		const value = source.get(key)?.trim();
		if (value) params.set(key, value);
	}

	const query = params.toString();
	return query ? `?${query}` : '';
}

function manifestHrefForUrl(requestUrl?: string): string {
	const startSearch = pwaStartSearchFromUrl(requestUrl);
	const versionSeparator = startSearch ? '&' : '?';
	return `/notifications/manifest.json${startSearch}${versionSeparator}v=${PWA_ASSET_VERSION}`;
}

export function createPwaHtml(requestUrl?: string): string {
	const manifestHref = manifestHrefForUrl(requestUrl);
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, height=device-height, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Crate">
<meta name="mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#1e1e1e">
<meta name="referrer" content="no-referrer">
<link rel="manifest" href="${manifestHref}">
<link rel="apple-touch-icon" href="/notifications/icon.svg?v=${PWA_ASSET_VERSION}">
<title>Crate Reminders</title>
<style>
:root{
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
	--keyboard-sheet-offset:0px;
	--keyboard-sheet-overlap:0px;
	--keyboard-usable-height:100dvh;
	--heroui-primary:263 90% 61%;
	--heroui-secondary:263 90% 61%;
	--heroui-danger:0 100% 65%;
	--heroui-warning:38 92% 55%;
	--heroui-success:142 71% 45%;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;padding:0;background:linear-gradient(180deg,#131820 0%,#0c0f14 44%,#090a0d 100%);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Segoe UI",system-ui,sans-serif;height:100%;overflow:hidden;overscroll-behavior:none;color-scheme:dark}
body{width:100%;min-height:100%;overflow:hidden}
button,input,textarea,select{font:inherit}
button{cursor:pointer;border:none;background:transparent;color:inherit}
button:disabled{cursor:not-allowed;opacity:.55}
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
.primary-button,.secondary-button{border-radius:11px;padding:9px 12px;font-weight:740;font-size:13.5px;min-height:38px}
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

/* Obsidian reminders view parity. Keep this standalone PWA visually aligned with the plugin UI. */
:root{
	--background-primary:#1e1e1e;
	--background-secondary:#161616;
	--background-modifier-border:#333333;
	--text-normal:#dcddde;
	--text-muted:#999999;
	--text-faint:#6f6f6f;
	--font-interface:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;
	--reminder-red:#e53935;
	--accent:#7c3aed;
	--accent-rgb:124,58,237;
	--accent-strong:#7c3aed;
	--shadow:none;
	--tabbar-h:80px;
	--reminders-tabbar-height:80px;
	--reminders-fab-gap:24px;
	--reminders-fab-size:56px;
}
html,body{background:var(--background-primary);font-family:var(--font-interface);color:var(--text-normal)}
#app{background:var(--background-primary)}
.app-shell{background:var(--background-primary);--reminders-tabbar-overlay:0px;--reminders-safe-area:0px}
.app-header{padding:calc(env(safe-area-inset-top) + 16px) 20px 12px;background:transparent;backdrop-filter:none;border-bottom:1px solid var(--background-modifier-border)}
.app-header__row{align-items:flex-start;gap:12px}
.app-header__body{animation:header-title-in 240ms cubic-bezier(.16,1,.3,1)}
.app-header__body h1{font-size:28px;font-weight:600;line-height:1.2;letter-spacing:0;color:var(--text-normal)}
.header-meta{gap:8px;margin-top:4px;min-height:28px;font-size:14px;color:var(--text-muted)}
.overdue-pill{padding:4px 12px;background:var(--reminder-red);border:none;border-radius:12px;color:white;font-size:14px;font-weight:600}
.icon-button{width:36px;height:36px;min-width:36px;border-radius:10px;background:rgba(255,255,255,.045);color:var(--text-muted)}
.icon-button.is-active{background:rgba(124,58,237,.10);color:#7c3aed}
.app-content{background:var(--background-primary);padding:16px 16px calc(var(--reminders-tabbar-height) + var(--reminders-fab-gap) + var(--reminders-fab-size) + env(safe-area-inset-bottom));overflow-x:hidden}
.view-transition{will-change:transform,opacity;transform-origin:center top}
.view-transition--forward{animation:view-slide-forward 280ms cubic-bezier(.16,1,.3,1)}
.view-transition--backward{animation:view-slide-backward 280ms cubic-bezier(.16,1,.3,1)}
.view-transition--none{animation:none}
.reminders-stack,.reorder-list,.completed-list{gap:0}
.date-group{margin-bottom:24px}
.date-group__title{margin:0 0 12px;padding-left:4px;font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em}
.project-card{background:transparent;border:none;box-shadow:none;margin-bottom:10px;padding:0}
.project-card__row{padding:14px 16px;border-radius:14px;background:rgba(255,255,255,.015);border:1px solid rgba(255,255,255,.03);box-shadow:0 2px 8px rgba(0,0,0,.04)}
.project-card__title{font-size:14px;font-weight:500;color:var(--text-normal);letter-spacing:0}
.project-card__meta{font-size:12px;color:var(--text-muted)}
.project-card__icon{background:rgba(var(--project-rgb,124,58,237),.08);border-radius:10px}
.reminder-card,.premium-reminder-card{position:relative;margin-bottom:10px;background:transparent;border:none;border-radius:12px;box-shadow:none;overflow:visible}
.reminder-card[data-drag-handle="true"]{cursor:grab}
.reminder-card[data-drag-handle="true"]:active{cursor:grabbing}
.reminder-card__main,.premium-reminder-content{position:relative;display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border-radius:12px;cursor:pointer;background:rgba(255,255,255,.015);border:1px solid rgba(255,255,255,.03);box-shadow:0 2px 8px rgba(0,0,0,.04);transition:background 200ms ease-out,border-color 200ms ease-out}
.premium-reminder-card:active{transform:none}
.premium-reminder-card:hover .premium-reminder-content{background:rgba(255,255,255,.035);border-color:rgba(255,255,255,.06)}
.premium-reminder-card.is-completed .premium-reminder-content{opacity:.6;background:rgba(255,255,255,.01)}
.reorderable-reminder-list{touch-action:pan-y}
.reorderable-reminder-item{position:relative;touch-action:pan-y}
.reorderable-reminder-item .premium-reminder-content,.reorderable-reminder-item .reminder-card__main{padding-right:52px}
.reorder-drag-handle{position:absolute;top:50%;right:8px;z-index:2;width:40px;height:44px;display:grid;place-items:center;padding:0;border:none;border-radius:12px;color:var(--text-faint);background:transparent;cursor:grab;touch-action:none;transform:translateY(-50%)}
.reorder-drag-handle:active{cursor:grabbing;color:var(--text-muted);background:rgba(255,255,255,.04)}
.reorder-drag-handle svg{display:block}
.checkbox,.premium-checkbox{flex-shrink:0;width:20px;height:20px;min-width:20px;flex-basis:20px;border-radius:50%;border:2px solid rgba(255,255,255,.2);background:transparent;color:white;display:flex;align-items:center;justify-content:center;margin-top:1px;transition:all 200ms ease-out;padding:0}
.premium-checkbox:hover{border-color:rgba(255,255,255,.4);transform:scale(1.05)}
.premium-checkbox:active{transform:scale(.95)}
.premium-checkbox.is-checked{border-color:#22c55e;background:#22c55e;box-shadow:0 0 6px rgba(34,197,94,.35)}
.premium-checkbox-icon{color:white;animation:checkmarkPop 200ms ease-out}
@keyframes checkmarkPop{0%{transform:scale(0);opacity:0}50%{transform:scale(1.2)}100%{transform:scale(1);opacity:1}}
.card-body,.premium-reminder-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;background:transparent;border:none;padding:0;text-align:left;color:inherit}
.card-title-row,.premium-reminder-title-row{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;min-width:0}
.card-title,.premium-reminder-title{font-size:14px;font-weight:500;line-height:1.5;color:var(--text-normal);letter-spacing:0;position:relative;transition:color 200ms ease-out;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0;display:block}
.premium-reminder-title.is-completed{color:var(--text-muted);text-decoration:line-through;text-decoration-color:var(--text-faint);text-decoration-thickness:1.5px}
.card-description,.premium-reminder-description{font-size:12px;color:rgba(255,255,255,.4);margin-top:2px;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.priority-flag,.premium-priority-flag{flex-shrink:0;color:#ef4444;display:inline-flex;align-items:center}
.card-pills,.premium-reminder-pills{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:0}
.meta-pill,.tag-pill,.premium-pill{display:inline-flex;align-items:center;gap:4px;min-height:auto;padding:4px 10px 4px 8px;border-radius:6px;font-size:11px;font-weight:500;line-height:1;background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.05);color:var(--text-muted)}
.premium-pill svg{opacity:.7}
.meta-pill.is-overdue,.premium-pill.is-overdue{background:rgba(239,68,68,.12);color:#ef4444;border-color:rgba(239,68,68,.2)}
.premium-pill.is-overdue svg{opacity:1}
.premium-pill-project{padding-left:5px;gap:3px}
.premium-pill-project svg{opacity:.9}
.card-handle{display:none}
.completed-toggle{padding:8px 0 0;color:var(--text-muted);font-size:14px;font-weight:600}
.bottom-tabs{position:fixed;left:0;right:0;bottom:0;z-index:40;padding:8px 12px calc(8px + env(safe-area-inset-bottom));background:var(--background-primary);backdrop-filter:none;border-top:1px solid var(--background-modifier-border);display:grid;grid-template-columns:repeat(4,1fr);gap:0}
.tab-button{position:relative;width:100%;min-height:48px;padding:10px 16px;border-radius:12px;background:transparent;color:var(--text-faint);font-size:13px;font-weight:500;letter-spacing:.01em;gap:4px;transition:color 180ms ease,background 260ms cubic-bezier(.16,1,.3,1),transform 180ms ease}
.tab-button:active{transform:scale(.96)}
.tab-button__icon{width:24px;height:24px;border-radius:0;background:transparent;transition:transform 260ms cubic-bezier(.16,1,.3,1),color 180ms ease}
.tab-button.is-active{background:rgba(124,58,237,.10);color:#7c3aed;font-weight:600;animation:tab-active-pop 260ms cubic-bezier(.16,1,.3,1)}
.tab-button.is-active .tab-button__icon{background:transparent;transform:translateY(-1px) scale(1.04)}
.fab{right:16px;bottom:calc(var(--reminders-tabbar-height) + var(--reminders-fab-gap) + env(safe-area-inset-bottom));width:56px;height:56px;min-width:56px;border-radius:50%;background:#7c3aed;color:white;box-shadow:0 4px 12px rgba(124,58,237,.4);display:flex;align-items:center;justify-content:center}
.fab:hover{box-shadow:0 6px 16px rgba(124,58,237,.5)}
.modal-card,.settings-sheet{background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:24px 24px 0 0}
.composer-surface,.composer-panel{background:rgba(255,255,255,.015);border:1px solid rgba(255,255,255,.03);border-radius:14px}
.field input,.field textarea,.field select{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08);color:var(--text-normal)}
.placeholder-card{min-height:64px;background:rgba(124,58,237,.08);border:1px dashed rgba(124,58,237,.35);border-radius:12px}
.is-dragging{opacity:.98;box-shadow:0 10px 24px rgba(0,0,0,.25)}
.reminders-shadow-root{height:100%;width:100%;max-width:100vw;display:flex;flex-direction:column;overflow:visible;color:var(--text-normal);font-family:var(--font-interface);font-size:var(--font-ui-medium,14px);background:var(--background-primary)}
.pwa-reminders-view{position:fixed;inset:0;flex:1;min-height:0;width:100%;max-width:100vw;height:auto;display:flex;flex-direction:column;overflow:visible;--pwa-tabbar-content-height:64px;--pwa-tabbar-safe-area:env(safe-area-inset-bottom);--reminders-tabbar-height:calc(var(--pwa-tabbar-content-height) + var(--pwa-tabbar-safe-area));--reminders-tabbar-overlay:var(--reminders-tabbar-height);--reminders-tabbar-bottom-offset:0px;--reminders-bottom-gap:16px;--reminders-fab-gap:18px;--reminders-fab-size:56px;--reminders-safe-area:0px;--pwa-tabbar-bleed:0px;background:var(--background-primary)}
.pwa-reminders-view.is-fullscreen{--reminders-tabbar-overlay:var(--reminders-tabbar-height);--reminders-safe-area:0px;--reminders-tabbar-bottom-offset:0px;--reminders-fab-gap:18px}
.pwa-reminders-view .view-header{max-width:100vw;overflow:hidden;padding:calc(env(safe-area-inset-top) + 16px) 20px 12px!important;gap:12px}
.pwa-reminders-view .view-header>div:first-child{min-width:0;flex:1 1 auto!important;width:0}
.pwa-header-actions{display:flex;align-items:flex-start;justify-content:flex-end;gap:8px;min-width:0}
.pwa-header-settings-button,.pwa-header-sync-button{position:relative;width:40px;height:40px;min-width:40px;border-radius:14px;display:grid;place-items:center;margin-top:2px;padding:0;color:var(--text-muted);background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.055);box-shadow:0 2px 8px rgba(0,0,0,.04)}
.pwa-header-settings-button svg,.pwa-header-sync-button svg{display:block}
.pwa-header-settings-button:hover,.pwa-header-settings-button.is-active,.pwa-header-sync-button:hover{color:var(--text-normal);background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.09)}
.pwa-header-sync-button.is-refreshing svg{animation:pwa-spin .8s linear infinite}
.pwa-header-sync-button__dot{position:absolute;top:6px;right:6px;width:8px;height:8px;border-radius:50%;background:#22c55e;border:2px solid var(--background-primary);box-shadow:0 0 0 2px rgba(34,197,94,.16)}
.pwa-header-sync-button.is-cached .pwa-header-sync-button__dot,.pwa-header-sync-button.is-offline .pwa-header-sync-button__dot{background:#f59e0b;box-shadow:0 0 0 2px rgba(245,158,11,.16)}
.pwa-header-sync-button.is-error .pwa-header-sync-button__dot{background:#ef4444;box-shadow:0 0 0 2px rgba(239,68,68,.16)}
.pwa-reminders-view .reminders-content{flex:1;min-height:0;overflow:hidden;padding-bottom:0;position:relative}
.pwa-top-notices{flex-shrink:0;display:flex;flex-direction:column;gap:8px;padding:12px 20px 4px;background:var(--background-primary)}
.pwa-top-notices:empty{display:none}
.pwa-status-line,.pwa-notification-prompt{width:100%;border-radius:12px;border:1px solid rgba(255,255,255,.06);background:rgba(255,255,255,.025);color:var(--text-muted)}
.pwa-status-line{padding:7px 10px;font-size:12px;font-weight:600;line-height:1.35;text-align:center}
.pwa-status-line.is-offline,.pwa-status-line.is-cached,.pwa-status-line.is-error{background:rgba(245,158,11,.10);border-color:rgba(245,158,11,.18);color:#fbbf24}
.pwa-status-line.is-live{background:rgba(255,255,255,.018)}
.pwa-update-banner{align-self:stretch;min-width:0;min-height:44px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 14px;border-radius:13px;color:var(--text-normal);background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.055);box-shadow:none;animation:pwa-update-slide-in .2s cubic-bezier(.32,.72,0,1) both}
.pwa-update-banner__label{min-width:0;display:flex;align-items:center;gap:10px}
.pwa-update-banner__dot{width:7px;height:7px;min-width:7px;border-radius:50%;background:#a78bfa;box-shadow:0 0 0 3px rgba(167,139,250,.13)}
.pwa-update-banner__text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:650;line-height:1.2;color:rgba(220,221,222,.90)}
.pwa-inline-button{height:32px;min-height:32px;border-radius:10px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;background:#7c3aed;color:white;font-size:12px;font-weight:700;white-space:nowrap}
.pwa-update-button{height:32px;min-height:32px;border-radius:9px;padding:0 8px;background:transparent;border:0;color:#a78bfa;font-size:13px;font-weight:720;line-height:1;white-space:nowrap}
.pwa-update-button:active{background:rgba(124,58,237,.12);transform:scale(.98)}
.pwa-inline-button svg{width:14px;height:14px;display:block}
.pwa-safe-area-debug{position:fixed;top:calc(env(safe-area-inset-top) + 8px);left:8px;right:8px;z-index:9999;max-height:44vh;overflow:auto;padding:10px 12px;border-radius:12px;background:rgba(0,0,0,.82);border:1px solid rgba(255,255,255,.18);box-shadow:0 12px 32px rgba(0,0,0,.36);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);color:white;font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;text-align:left;overscroll-behavior:contain}
.pwa-safe-area-debug__header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}
.pwa-safe-area-debug__header strong{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#c4b5fd}
.pwa-safe-area-debug__header button{height:24px;min-height:24px;padding:0 8px;border-radius:7px;background:rgba(124,58,237,.32);color:white;border:1px solid rgba(167,139,250,.36);font-size:11px;font-weight:700}
.pwa-safe-area-debug__row{display:grid;grid-template-columns:86px minmax(0,1fr);gap:8px;padding:2px 0;border-top:1px solid rgba(255,255,255,.07)}
.pwa-safe-area-debug__row span{color:rgba(255,255,255,.58);white-space:nowrap}
.pwa-safe-area-debug__row code{min-width:0;white-space:pre-wrap;word-break:break-word;color:rgba(255,255,255,.92);font:inherit}
.pwa-notification-prompt{display:flex;align-items:center;gap:10px;padding:10px}
.pwa-notification-prompt__icon{width:32px;height:32px;min-width:32px;display:grid;place-items:center;border-radius:10px;background:rgba(124,58,237,.14);color:#a78bfa}
.pwa-notification-prompt__copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.pwa-notification-prompt__copy strong{font-size:13px;font-weight:700;color:var(--text-normal);line-height:1.25}
.pwa-notification-prompt__copy span{font-size:12px;color:var(--text-muted);line-height:1.35}
.pwa-pull-refresh{flex-shrink:0;display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--background-primary);opacity:0;transition:height .32s cubic-bezier(.32,.72,0,1),opacity .16s ease}
.pwa-pull-refresh.is-visible{opacity:1}
.pwa-pull-refresh__inner{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-height:44px;transform:translateY(-2px)}
.pwa-pull-refresh__glyph{width:28px;height:28px;display:grid;place-items:center;border-radius:50%;color:#a78bfa;background:rgba(124,58,237,.10);border:1px solid rgba(124,58,237,.16);box-shadow:0 4px 14px rgba(0,0,0,.14);transition:transform .18s cubic-bezier(.32,.72,0,1),color .16s ease,background .16s ease,border-color .16s ease}
.pwa-pull-refresh.is-ready .pwa-pull-refresh__glyph,.pwa-pull-refresh.is-refreshing .pwa-pull-refresh__glyph{color:white;background:#7c3aed;border-color:rgba(124,58,237,.55);box-shadow:0 6px 18px rgba(124,58,237,.24)}
.pwa-pull-refresh__glyph svg{width:19px;height:19px;display:block}
.pwa-pull-refresh.is-refreshing .pwa-pull-refresh__glyph svg{animation:pwa-spin .82s linear infinite}
.pwa-pull-refresh__label{font-size:10.5px;font-weight:650;line-height:1;color:#a78bfa;white-space:nowrap}
.pwa-loading-state{height:100%;padding:16px}
.pwa-skeleton-header{padding:2px 4px 16px}
.pwa-skeleton-list{display:flex;flex-direction:column;gap:10px}
.pwa-skeleton-row{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border-radius:12px;background:rgba(255,255,255,.015);border:1px solid rgba(255,255,255,.03)}
.pwa-skeleton-check{width:20px;height:20px;min-width:20px;border-radius:50%;background:rgba(255,255,255,.07)}
.pwa-skeleton-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:9px;padding-top:2px}
.pwa-skeleton-line{height:12px;border-radius:999px;background:linear-gradient(90deg,rgba(255,255,255,.045),rgba(255,255,255,.09),rgba(255,255,255,.045));background-size:220% 100%;animation:pwa-skeleton-shimmer 1.4s ease-in-out infinite}
.pwa-skeleton-line.is-title{width:38%;height:16px}
.pwa-skeleton-line.is-meta{width:24%;height:11px;margin-top:8px}
.pwa-skeleton-line.is-short{width:46%;height:10px}
.pwa-reminders-view .bottom-tab-bar{width:100%;max-width:none;height:var(--reminders-tabbar-height);overflow:visible;padding-bottom:0;transform:none}
.pwa-reminders-view .bottom-tab-bar>div{display:flex!important;align-items:center;justify-content:space-around;width:100%;height:var(--pwa-tabbar-content-height);max-width:42rem!important;margin:0 auto!important;padding:0!important}
.pwa-reminders-view .bottom-tab-bar [data-action="switch-tab"]{flex:1 1 0%!important;width:auto!important;max-width:100%!important;min-width:0!important;height:100%!important;min-height:0!important;padding:0!important}
.pwa-reminders-view .bottom-tab-bar [data-action="switch-tab"]>div:last-child{transform:none}
.pwa-reminders-view .reminders-fab.fab{position:absolute;right:16px;bottom:calc(var(--reminders-tabbar-height) + var(--reminders-fab-gap) - var(--pwa-tabbar-bleed))}
.pwa-reminder-editor-backdrop{align-items:flex-end;justify-content:center;padding:0 18px var(--keyboard-sheet-offset,var(--keyboard-offset));background:rgba(0,0,0,.56);backdrop-filter:blur(8px);transition:padding-bottom .22s cubic-bezier(.32,.72,0,1)}
.modal-card.pwa-reminder-editor{width:min(1120px,calc(100vw - 36px));max-height:calc(var(--keyboard-usable-height,100dvh) - 72px + var(--keyboard-sheet-overlap,0px));overflow:auto;background:#1f1f1f;border:1px solid rgba(255,255,255,.08);border-bottom:none;border-radius:24px 24px 0 0;padding:12px 44px calc(76px + env(safe-area-inset-bottom));box-shadow:0 -12px 48px rgba(0,0,0,.38);backface-visibility:hidden;transform:translate3d(0,0,0);will-change:transform;animation:pwa-sheet-in .36s cubic-bezier(.32,.72,0,1) both}
.modal-card.pwa-reminder-editor.is-switching-out{pointer-events:none;animation:pwa-sheet-out .22s cubic-bezier(.4,0,1,1) forwards}
.modal-card.pwa-reminder-editor::before{content:"";display:block;width:40px;height:5px;margin:0 auto 18px;border-radius:999px;background:rgba(255,255,255,.16)}
.pwa-reminder-editor .modal-form{gap:0}
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
.pwa-picker-sheet{width:min(620px,calc(100vw - 36px));max-height:calc(var(--keyboard-usable-height,100dvh) - 88px + var(--keyboard-sheet-overlap,0px));overflow:auto;background:#1f1f1f;border:1px solid rgba(255,255,255,.08);border-bottom:none;border-radius:24px 24px 0 0;padding:12px 24px calc(24px + env(safe-area-inset-bottom));box-shadow:0 -12px 48px rgba(0,0,0,.42);backface-visibility:hidden;transform:translate3d(0,0,0);will-change:transform;animation:pwa-sheet-in .36s cubic-bezier(.32,.72,0,1) both}
.pwa-picker-sheet.is-switching-out{pointer-events:none;animation:pwa-sheet-out .22s cubic-bezier(.4,0,1,1) forwards}
.pwa-picker-sheet::before{content:"";display:block;width:40px;height:5px;margin:0 auto 16px;border-radius:999px;background:rgba(255,255,255,.16)}
.pwa-picker-header{display:grid;grid-template-columns:44px minmax(0,1fr) 44px;align-items:center;gap:12px;margin-bottom:18px}
.pwa-picker-header h3{margin:0;text-align:center;font-size:18px;font-weight:600;line-height:1.2;letter-spacing:0;color:var(--text-normal)}
.pwa-picker-icon-button{width:44px;height:44px;min-width:44px;border-radius:50%;display:grid;place-items:center;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.055);color:var(--text-muted);padding:0}
.pwa-picker-icon-button--done{background:#7c3aed;border-color:rgba(124,58,237,.55);color:white;box-shadow:0 6px 18px rgba(124,58,237,.28)}
.pwa-picker-content{display:flex;flex-direction:column;gap:14px}
.pwa-picker-presets,.pwa-project-list{display:flex;flex-direction:column;gap:8px}
.pwa-project-list{max-height:280px;overflow:auto;padding-right:2px}
.pwa-picker-option,.pwa-project-option{width:100%;height:48px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-radius:14px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.07);color:var(--text-normal);font-size:14px;font-weight:600;padding:0 14px;text-align:left}
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
.pwa-picker-field input{width:100%;height:46px;border-radius:14px;border:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.045);color:var(--text-normal);padding:0 12px;outline:none;font-size:16px;font-family:inherit;-webkit-appearance:none}
.pwa-picker-field input:focus{border-color:rgba(124,58,237,.44);box-shadow:0 0 0 3px rgba(124,58,237,.12)}
.pwa-recurrence-picker-sheet{width:min(620px,calc(100vw - 36px))}
.pwa-recurrence-segmented{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;padding:4px;border-radius:14px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.07)}
.pwa-recurrence-segment{height:38px;border-radius:10px;color:var(--text-muted);font-size:13px;font-weight:650}
.pwa-recurrence-segment.is-active{background:#7c3aed;color:white;box-shadow:0 2px 10px rgba(124,58,237,.24)}
.pwa-recurrence-stepper{display:flex;align-items:center;justify-content:center;gap:10px;min-height:64px;border-radius:14px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.07);color:var(--text-muted);font-size:14px;font-weight:600}
.pwa-recurrence-stepper strong{min-width:36px;text-align:center;color:var(--text-normal);font-size:16px}
.pwa-recurrence-stepper__button{width:36px;height:36px;min-width:36px;border-radius:10px;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.07);color:var(--text-normal);font-size:16px;font-weight:700}
.pwa-recurrence-days{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}
.pwa-recurrence-day{aspect-ratio:1;min-width:0;width:100%;height:auto;border-radius:12px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.07);color:var(--text-muted);font-size:12px;font-weight:700}
.pwa-recurrence-day.is-active{background:#7c3aed;border-color:rgba(124,58,237,.55);color:white}
.pwa-recurrence-time-field{border-radius:14px;background:rgba(255,255,255,.025)}
.pwa-keyboard-open .modal-card.pwa-reminder-editor{padding-bottom:calc(24px + env(safe-area-inset-bottom) + var(--keyboard-sheet-overlap,0px))}
.pwa-keyboard-open .pwa-editor-header{margin-bottom:18px}
.pwa-keyboard-open .pwa-editor-card{padding:16px 18px 18px}
.pwa-keyboard-open .pwa-editor-title-input{max-height:96px}
.pwa-keyboard-open .pwa-editor-description-input{flex:0 1 auto;min-height:42px;max-height:88px}
.pwa-keyboard-open .pwa-editor-divider{margin:12px 0 14px}
.pwa-keyboard-open .pwa-editor-chip-row{flex-wrap:nowrap;gap:8px;margin-top:16px;padding-top:14px;overflow-x:auto;scrollbar-width:none}
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
.pwa-reminders-view.is-fullscreen .animated-tab-bar-bottom{position:relative;bottom:auto;left:auto;right:auto;flex-shrink:0;margin-bottom:0;transform:none}
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
	.pwa-reminder-editor-backdrop{align-items:flex-end;padding:0 0 var(--keyboard-sheet-offset,var(--keyboard-offset))}
	.settings-backdrop{align-items:flex-end;padding:0 0 var(--keyboard-offset)}
	.modal-card.pwa-reminder-editor{width:100vw;max-height:calc(var(--keyboard-usable-height,100dvh) - 28px + var(--keyboard-sheet-overlap,0px));padding:12px 24px calc(28px + env(safe-area-inset-bottom));border-right:none;border-left:none;border-radius:24px 24px 0 0}
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
	.pwa-picker-sheet{width:100vw;max-height:calc(var(--keyboard-usable-height,100dvh) - 28px + var(--keyboard-sheet-overlap,0px));padding:12px 24px calc(24px + env(safe-area-inset-bottom));border-right:none;border-left:none;border-radius:24px 24px 0 0}
}
@media (max-height: 900px) and (min-width: 641px){
	.modal-card.pwa-reminder-editor{max-height:calc(var(--keyboard-usable-height,100dvh) - 36px + var(--keyboard-sheet-overlap,0px));padding-bottom:calc(32px + env(safe-area-inset-bottom))}
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
	.pwa-header-settings-button{width:38px;height:38px;min-width:38px}
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
}
</style>
</head>
	<body>
	<div id="app"></div>
	<script>
	(function() {
		var blockZoom = function(event) {
			event.preventDefault();
		};
		document.addEventListener('gesturestart', blockZoom, { passive: false });
		document.addEventListener('gesturechange', blockZoom, { passive: false });
		document.addEventListener('gestureend', blockZoom, { passive: false });
	})();
	</script>
	<script type="module" src="/notifications/app.js?v=${PWA_ASSET_VERSION}"></script>
	</body>
	</html>`;
}

export const PWA_HTML = createPwaHtml();

export const PWA_APP_JS = PWA_CLIENT_JS;

export function createPwaVersionJson(): string {
	return JSON.stringify({ assetVersion: PWA_ASSET_VERSION });
}

export const SERVICE_WORKER_JS = `
self.addEventListener('push', function(event) {
	const data = event.data ? event.data.json() : {};
	event.waitUntil(
		self.registration.showNotification(data.title || 'Reminder', {
			body: data.body || '',
			tag: data.tag || 'crate-reminder',
			icon: '/notifications/icon.svg?v=${PWA_ASSET_VERSION}',
			data: {
				project: data.project || '',
				reminderId: data.reminderId || '',
			},
		})
	);
});

self.addEventListener('notificationclick', function(event) {
	event.notification.close();
	var project = (event.notification.data && event.notification.data.project) || '';
	var reminderId = (event.notification.data && event.notification.data.reminderId) || '';
	var params = new URLSearchParams();
	if (project) params.set('project', project);
	if (reminderId) params.set('reminderId', reminderId);
	var url = '/notifications' + (params.toString() ? '?' + params.toString() : '');
	event.waitUntil(clients.openWindow(url));
});

self.addEventListener('pushsubscriptionchange', function() {
	// Re-subscription is handled by the app the next time it opens.
});
`;

export const OPEN_OBSIDIAN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opening Obsidian...</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f0f10;color:#f4f4f5;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#181818;border-radius:20px;padding:32px;max-width:420px;width:100%;text-align:center;box-shadow:0 18px 48px rgba(0,0,0,.4)}
h1{font-size:1.3rem;margin-bottom:16px;color:#fff}
.btn{display:inline-block;padding:14px 28px;border:none;border-radius:14px;font-size:1rem;font-weight:600;cursor:pointer;background:#7c3aed;color:#fff;text-decoration:none;margin-top:8px}
p{color:#a1a1aa;font-size:.9rem;margin-top:16px;line-height:1.5}
</style>
</head>
<body>
<div class="card">
<h1>Opening Obsidian...</h1>
<a id="open-link" href="obsidian://open" class="btn">Open Obsidian</a>
<p>If Obsidian didn't open automatically, tap the button above.</p>
</div>
<script>
var params = new URLSearchParams(location.search);
var project = params.get('project');
var uri = project ? 'obsidian://crate-reminders?project=' + encodeURIComponent(project) : 'obsidian://crate-reminders';
document.getElementById('open-link').href = uri;
window.location.href = uri;
</script>
</body>
</html>`;

export function createManifestJson(requestUrl?: string): string {
	return JSON.stringify({
		id: '/notifications',
		name: 'Crate Reminders',
		short_name: 'Crate',
		description: 'Manage Crate reminders without opening Obsidian.',
		start_url: `/notifications${pwaStartSearchFromUrl(requestUrl)}`,
		scope: '/notifications',
		display: 'standalone',
		display_override: ['standalone', 'minimal-ui'],
		orientation: 'portrait',
		background_color: '#1e1e1e',
		theme_color: '#1e1e1e',
		icons: [
			{
				src: `/notifications/icon.svg?v=${PWA_ASSET_VERSION}`,
				sizes: 'any',
				type: 'image/svg+xml',
				purpose: 'any maskable',
			},
		],
	});
}

export const MANIFEST_JSON = createManifestJson();

export const ICON_SVG = `<svg id="custom-logo" width="512" height="512" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" style="height:100%;width:100%;">
  <defs>
    <radialGradient id="b" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(-48 -185 123 -32 179 429.7)">
      <stop stop-color="#fff" stop-opacity=".4"/>
      <stop offset="1" stop-opacity=".1"/>
    </radialGradient>
    <radialGradient id="c" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(41 -310 229 30 341.6 351.3)">
      <stop stop-color="#fff" stop-opacity=".6"/>
      <stop offset="1" stop-color="#fff" stop-opacity=".1"/>
    </radialGradient>
    <radialGradient id="d" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(57 -261 178 39 190.5 296.3)">
      <stop stop-color="#fff" stop-opacity=".8"/>
      <stop offset="1" stop-color="#fff" stop-opacity=".4"/>
    </radialGradient>
    <radialGradient id="e" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(-79 -133 153 -90 321.4 464.2)">
      <stop stop-color="#fff" stop-opacity=".3"/>
      <stop offset="1" stop-opacity=".3"/>
    </radialGradient>
    <radialGradient id="f" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(-29 136 -92 -20 300.7 149.9)">
      <stop stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#fff" stop-opacity=".2"/>
    </radialGradient>
    <radialGradient id="g" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(72 73 -155 153 137.8 225.2)">
      <stop stop-color="#fff" stop-opacity=".2"/>
      <stop offset="1" stop-color="#fff" stop-opacity=".4"/>
    </radialGradient>
    <radialGradient id="h" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(20 118 -251 43 215.1 273.7)">
      <stop stop-color="#fff" stop-opacity=".1"/>
      <stop offset="1" stop-color="#fff" stop-opacity=".3"/>
    </radialGradient>
    <radialGradient id="i" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(-162 -85 268 -510 374.4 371.7)">
      <stop stop-color="#fff" stop-opacity=".2"/>
      <stop offset=".5" stop-color="#fff" stop-opacity=".2"/>
      <stop offset="1" stop-color="#fff" stop-opacity=".3"/>
    </radialGradient>
    <filter id="a" x="80.1" y="37" width="351.1" height="443.2" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"/>
      <feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/>
      <feGaussianBlur stdDeviation="6.5" result="effect1_foregroundBlur_744_9191"/>
    </filter>
  </defs>
  <rect id="logo-bg" fill="#262626" width="512" height="512" rx="100"/>
  <g filter="url(#a)">
    <path d="M359.2 437.5c-2.6 19-21.3 33.9-40 28.7-26.5-7.2-57.2-18.6-84.8-20.7l-42.4-3.2a28 28 0 0 1-18-8.3l-73-74.8a27.7 27.7 0 0 1-5.4-30.7s45-98.6 46.8-103.7c1.6-5.1 7.8-49.9 11.4-73.9a28 28 0 0 1 9-16.5L249 57.2a28 28 0 0 1 40.6 3.4l72.6 91.6a29.5 29.5 0 0 1 6.2 18.3c0 17.3 1.5 53 11.2 76a301.3 301.3 0 0 0 35.6 58.2 14 14 0 0 1 1 15.6c-6.3 10.7-18.9 31.3-36.6 57.6a142.2 142.2 0 0 0-20.5 59.6Z" fill="#000" fill-opacity=".3"/>
  </g>
  <path id="arrow" d="M359.9 434.3c-2.6 19.1-21.3 34-40 28.9-26.4-7.3-57-18.7-84.7-20.8l-42.3-3.2a27.9 27.9 0 0 1-18-8.4l-73-75a27.9 27.9 0 0 1-5.4-31s45.1-99 46.8-104.2c1.7-5.1 7.8-50 11.4-74.2a28 28 0 0 1 9-16.6l86.2-77.5a28 28 0 0 1 40.6 3.5l72.5 92a29.7 29.7 0 0 1 6.2 18.3c0 17.4 1.5 53.2 11.1 76.3a303 303 0 0 0 35.6 58.5 14 14 0 0 1 1.1 15.7c-6.4 10.8-18.9 31.4-36.7 57.9a143.3 143.3 0 0 0-20.4 59.8Z" fill="#6C31E3"/>
  <path d="M182.7 436.4c33.9-68.7 33-118 18.5-153-13.2-32.4-37.9-52.8-57.3-65.5-.4 1.9-1 3.7-1.8 5.4L96.5 324.8a27.9 27.9 0 0 0 5.5 31l72.9 75c2.3 2.3 5 4.2 7.8 5.6Z" fill="url(#b)"/>
  <path d="M274.9 297c9.1.9 18 2.9 26.8 6.1 27.8 10.4 53.1 33.8 74 78.9 1.5-2.6 3-5.1 4.6-7.5a1222 1222 0 0 0 36.7-57.9 14 14 0 0 0-1-15.7 303 303 0 0 1-35.7-58.5c-9.6-23-11-58.9-11.1-76.3 0-6.6-2.1-13.1-6.2-18.3l-72.5-92-1.2-1.5c5.3 17.5 5 31.5 1.7 44.2-3 11.8-8.6 22.5-14.5 33.8-2 3.8-4 7.7-5.9 11.7a140 140 0 0 0-15.8 58c-1 24.2 3.9 54.5 20 95Z" fill="url(#c)"/>
  <path d="M274.8 297c-16.1-40.5-21-70.8-20-95 1-24 8-42 15.8-58l6-11.7c5.8-11.3 11.3-22 14.4-33.8a78.5 78.5 0 0 0-1.7-44.2 28 28 0 0 0-39.4-2l-86.2 77.5a28 28 0 0 0-9 16.6L144.2 216c0 .7-.2 1.3-.3 2 19.4 12.6 44 33 57.3 65.3 2.6 6.4 4.8 13.1 6.4 20.4a200 200 0 0 1 67.2-6.8Z" fill="url(#d)"/>
  <path d="M320 463.2c18.6 5.1 37.3-9.8 39.9-29a153 153 0 0 1 15.9-52.2c-21-45.1-46.3-68.5-74-78.9-29.5-11-61.6-7.3-94.2.6 7.3 33.1 3 76.4-24.8 132.7 3.1 1.6 6.6 2.5 10.1 2.8l43.9 3.3c23.8 1.7 59.3 14 83.2 20.7Z" fill="url(#e)"/>
  <path fill-rule="evenodd" clip-rule="evenodd" d="M255 200.5c-1.1 24 1.9 51.4 18 91.8l-5-.5c-14.5-42.1-17.7-63.7-16.6-88 1-24.3 8.9-43 16.7-59 2-4 6.6-11.5 8.6-15.3 5.8-11.3 9.7-17.2 13-27.5 4.8-14.4 3.8-21.2 3.2-28 3.7 24.5-10.4 45.8-21 67.5a145 145 0 0 0-17 59Z" fill="url(#f)"/>
  <path fill-rule="evenodd" clip-rule="evenodd" d="M206 285.1c2 4.4 3.7 8 4.9 13.5l-4.3 1c-1.7-6.4-3-11-5.5-16.5-14.6-34.3-38-52-57-65 23 12.4 46.7 31.9 61.9 67Z" fill="url(#g)"/>
  <path fill-rule="evenodd" clip-rule="evenodd" d="M211.1 303c8 37.5-1 85.2-27.5 131.6 22.2-46 33-90.1 24-131l3.5-.7Z" fill="url(#h)"/>
  <path fill-rule="evenodd" clip-rule="evenodd" d="M302.7 299.5c43.5 16.3 60.3 52 72.8 81.9-15.5-31.2-37-65.7-74.4-78.5-28.4-9.8-52.4-8.6-93.5.7l-.9-4c43.6-10 66.4-11.2 96 0Z" fill="url(#i)"/>
</svg>`;
