import replace from "@rollup/plugin-replace";
import preact from "@preact/preset-vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vite";
import { resolve } from "node:path";
import { builtinModules } from "node:module";
import { existsSync, readFileSync } from "node:fs";

function readGeneratedWorkerScript() {
	const generatedPath = resolve(__dirname, ".generated/cloudflare/worker-script.json");
	if (!existsSync(generatedPath)) {
		return "";
	}

	const payload = JSON.parse(readFileSync(generatedPath, "utf-8"));
	return typeof payload.script === "string" ? payload.script : "";
}

export default defineConfig({
	define: {
		__CRATE_WORKER_SCRIPT__: JSON.stringify(readGeneratedWorkerScript()),
	},
	plugins: [
		preact(),
		tsConfigPaths({
			projects: [resolve(__dirname, "tsconfig.json")],
		}),
		replace({
			"process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "production"),
			preventAssignment: true,
		}),
	],
	build: {
		minify: true,
		lib: {
			entry: resolve(__dirname, "src/main.ts"),
			fileName: "main",
			formats: ["cjs"],
		},
		rollupOptions: {
			external: [
				"obsidian",
				"electron",
				"@codemirror/autocomplete",
				"@codemirror/collab",
				"@codemirror/commands",
				"@codemirror/language",
				"@codemirror/lint",
				"@codemirror/search",
				"@codemirror/state",
				"@codemirror/view",
				"@lezer/common",
				"@lezer/highlight",
				"@lezer/lr",
				"better-sqlite3",
				...builtinModules,
				...builtinModules.map((m) => `node:${m}`),
			],
			output: {
				globals: {
					obsidian: "obsidian",
				},
				entryFileNames: "main.js",
				assetFileNames: (assetInfo) => {
					if (assetInfo.name === "index.css" || assetInfo.name === "main.css") {
						return "styles.css";
					}
					return assetInfo.name ?? "asset";
				},
				inlineDynamicImports: true,
			},
		},
		sourcemap: false,
		emptyOutDir: true,
		outDir: "dist",
	},
	resolve: {
		alias: {
			"react": "preact/compat",
			"react-dom": "preact/compat",
			"react/jsx-runtime": "preact/jsx-runtime",
		},
	},
});
