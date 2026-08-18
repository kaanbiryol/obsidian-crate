import setupClientJs from './setup-client.js?raw-text';

const SECURITY_HEADERS: Record<string, string> = {
	'Cache-Control': 'no-store',
	'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	'Referrer-Policy': 'no-referrer',
	'X-Content-Type-Options': 'nosniff',
	'X-Frame-Options': 'DENY',
};

export function handleSetupPage(): Response {
	return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Set up Crate</title>
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#101114;color:#f5f7fa}
*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at top,#28314a 0,#101114 52%)}
main{width:min(560px,100%);padding:32px;border:1px solid #3a4150;border-radius:20px;background:#181b22;box-shadow:0 24px 80px #0008}
.eyebrow{margin:0 0 8px;color:#9aabda;font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}h1{margin:0 0 12px;font-size:clamp(28px,7vw,42px)}
p{line-height:1.55;color:#c8ceda}button,.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border:0;border-radius:10px;background:#7c9cff;color:#0d1220;font:inherit;font-weight:750;text-decoration:none;cursor:pointer}
button.secondary{background:#303747;color:#f5f7fa}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:24px}.hidden{display:none}.warning{margin-top:26px;padding:14px;border-radius:10px;background:#241f19;color:#e8d3b8;font-size:14px}
code{display:block;margin-top:16px;padding:12px;border-radius:8px;background:#0e1015;color:#aeb8cf;overflow-wrap:anywhere;font-size:11px}button:disabled{opacity:.6;cursor:wait}
</style>
</head>
<body>
<main>
<p class="eyebrow">Crate on Cloudflare</p>
<h1 id="state-title">Loading setup…</h1>
<p id="state-text">Checking this deployment.</p>
<div id="claim-actions" class="actions hidden"><button id="claim-button" type="button">Claim server</button></div>
<div id="ready-actions" class="hidden">
<div class="actions"><a id="open-button" class="button" href="#">Open in Obsidian</a><button id="copy-button" class="secondary" type="button">Copy setup link</button></div>
<code id="setup-link"></code>
</div>
<p id="security-note" class="warning">Claim a new deployment promptly. Until it is claimed, anyone who knows its Worker URL could claim it first.</p>
</main>
<script src="/setup/client.js" defer></script>
</body>
</html>`, {
		headers: {
			...SECURITY_HEADERS,
			'Content-Type': 'text/html; charset=utf-8',
		},
	});
}

export function handleSetupClient(): Response {
	return new Response(setupClientJs, {
		headers: {
			...SECURITY_HEADERS,
			'Content-Type': 'text/javascript; charset=utf-8',
		},
	});
}
