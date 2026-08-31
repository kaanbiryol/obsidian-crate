import replace from "@rollup/plugin-replace";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { resolve } from "node:path";
import { builtinModules } from "node:module";
import { testVaultDeployPlugin } from "./scripts/test-vault-vite-plugin.mjs";
import { cloudflareArtifactsPlugin } from "./scripts/cloudflare-artifacts-vite-plugin.mjs";

export default defineConfig(({ mode }) => ({
	plugins: [
		cloudflareArtifactsPlugin({ rootDir: __dirname }),
		preact(),
		replace({
			"process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "production"),
			preventAssignment: true,
		}),
		...(mode === "development" ? [testVaultDeployPlugin({ rootDir: __dirname })] : []),
	],
	define: {
		__CRATE_CLOUDFLARE_OAUTH_CLIENT_ID__: JSON.stringify(
			process.env.CRATE_CLOUDFLARE_OAUTH_CLIENT_ID || "9c474af284e49ff0201106f3b42cca05",
		),
	},
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
				comments: {
					legal: true,
				},
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
				codeSplitting: false,
			},
		},
		sourcemap: false,
		emptyOutDir: true,
		outDir: "dist",
	},
	resolve: {
		tsconfigPaths: true,
		alias: {
			"react": "preact/compat",
			"react-dom": "preact/compat",
			"react/jsx-runtime": "preact/jsx-runtime",
		},
	},
}));
