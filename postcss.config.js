import autoprefixer from "autoprefixer";
import tailwindcss from "@tailwindcss/postcss";

const CRATE_UI_SELECTOR = ".crate-reminders-ui";

function isWithinTailwindPropertiesLayer(rule) {
	let parent = rule.parent;
	while (parent) {
		if (parent.type === "atrule" && parent.name === "layer" && parent.params === "properties") {
			return true;
		}
		parent = parent.parent;
	}
	return false;
}

const scopeTailwindTheme = {
	postcssPlugin: "scope-crate-tailwind-theme",
	Rule(rule) {
		const selectors = rule.selectors?.map((selector) => selector.trim());
		if (selectors?.length === 2 && selectors.includes(":root") && selectors.includes(":host")) {
			rule.selector = CRATE_UI_SELECTOR;
			return;
		}

		if (
			isWithinTailwindPropertiesLayer(rule)
			&& selectors?.length === 4
			&& selectors.includes("*")
			&& selectors.includes(":before")
			&& selectors.includes(":after")
			&& selectors.includes("::backdrop")
		) {
			rule.selector = [
				CRATE_UI_SELECTOR,
				`${CRATE_UI_SELECTOR} *`,
				`${CRATE_UI_SELECTOR}::before`,
				`${CRATE_UI_SELECTOR} *::before`,
				`${CRATE_UI_SELECTOR}::after`,
				`${CRATE_UI_SELECTOR} *::after`,
				`${CRATE_UI_SELECTOR}::backdrop`,
				`${CRATE_UI_SELECTOR} *::backdrop`,
			].join(", ");
		}
	},
};

export default {
	plugins: [tailwindcss(), scopeTailwindTheme, autoprefixer()],
};
