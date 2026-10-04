import statusStyles from '../../../../site/assets/status.css?raw-css';
import { PWA_ASSET_VERSION } from '../pwa-version';

export const OPEN_OBSIDIAN_JS = `(()=>{
var params = new URLSearchParams(location.search);
var project = params.get('project');
var uri = project ? 'obsidian://crate-reminders?project=' + encodeURIComponent(project) : 'obsidian://crate-reminders';
document.getElementById('open-link').href = uri;
window.location.href = uri;
})();`;

export const OPEN_OBSIDIAN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Opening Obsidian...</title>
<style>${statusStyles}</style>
</head>
<body>
<main>
<div class="brand-lockup"><img src="/notifications/crate-mark-256.png" alt="Crate"></div>

<h1>Back to your vault.</h1>
<a id="open-link" href="obsidian://open" class="button">Open Obsidian</a>
<p class="helper">If Obsidian doesn’t open, select the button above.</p>
</main>
<script src="/notifications/open-obsidian.js?v=${PWA_ASSET_VERSION}"></script>
</body>
</html>`;
