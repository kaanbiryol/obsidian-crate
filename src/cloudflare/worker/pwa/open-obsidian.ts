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
</html>\``;
