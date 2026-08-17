import autoprefixer from "autoprefixer";
import tailwindcss from "@tailwindcss/postcss";

const CRATE_UI_SELECTOR = ".crate-reminders-ui";

const scopeTailwindTheme = {
	postcssPlugin: "scope-crate-tailwind-theme",
	Rule(rule) {
		const selectors = rule.selectors?.map((selector) => selector.trim());
		if (selectors?.length === 2 && selectors.includes(":root") && selectors.includes(":host")) {
			rule.selector = CRATE_UI_SELECTOR;
		}
	},
};

export default {
	plugins: [tailwindcss(), scopeTailwindTheme, autoprefixer()],
};
