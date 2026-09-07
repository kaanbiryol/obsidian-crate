import {
	PWA_LIGHT_SCHEME_MEDIA,
	PWA_LIGHT_THEME_STYLE_ID,
	PWA_THEME_COLOR_META_ID,
	PWA_THEME_PREFERENCE_KEY,
} from '../../../pwa/theme';
import { PWA_UPDATE_TRANSITION_KEY, PWA_UPDATE_TRANSITION_MAX_AGE_MS } from '../../../pwa/update-transition';
import { PWA_CHROME_COLOR, PWA_LIGHT_CHROME_COLOR } from './pwa-params';

export const PWA_THEME_BOOTSTRAP_JS = `(()=>{let preference='system';try{const stored=localStorage.getItem(${JSON.stringify(PWA_THEME_PREFERENCE_KEY)});if(stored==='light'||stored==='dark')preference=stored}catch{}const systemLight=window.matchMedia(${JSON.stringify(PWA_LIGHT_SCHEME_MEDIA)}).matches;const isLight=preference==='light'||(preference==='system'&&systemLight);const scheme=isLight?'light':'dark';const color=isLight?${JSON.stringify(PWA_LIGHT_CHROME_COLOR)}:${JSON.stringify(PWA_CHROME_COLOR)};const root=document.documentElement;root.dataset.pwaColorScheme=scheme;root.style.setProperty('--pwa-launch-bg',color);root.style.background=color;root.style.colorScheme=scheme;const lightTheme=document.getElementById(${JSON.stringify(PWA_LIGHT_THEME_STYLE_ID)});if(lightTheme)lightTheme.media=preference==='light'?'all':preference==='dark'?'not all':${JSON.stringify(PWA_LIGHT_SCHEME_MEDIA)};const themeColor=document.getElementById(${JSON.stringify(PWA_THEME_COLOR_META_ID)});if(themeColor){themeColor.setAttribute('media','all');themeColor.setAttribute('content',color)}})();
// Consume the marker before the first paint; ordinary launches stay unchanged.
(()=>{try{const key=${JSON.stringify(PWA_UPDATE_TRANSITION_KEY)};const started=Number(sessionStorage.getItem(key));sessionStorage.removeItem(key);const age=Date.now()-started;if(started>0&&age>=0&&age<${PWA_UPDATE_TRANSITION_MAX_AGE_MS})document.documentElement.dataset.pwaUpdating='restore'}catch{}})();`;
