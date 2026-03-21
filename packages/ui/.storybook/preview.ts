import type { Preview } from "@storybook/react-vite";
import "../src/styles.css";

const preview: Preview = {
	parameters: {
		backgrounds: {
			values: [
				{ name: "light", value: "#ffffff" },
				{ name: "dark", value: "#18181b" },
			],
		},
	},
};

export default preview;
