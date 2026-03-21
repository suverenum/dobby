import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
	framework: "@storybook/react-vite",
	stories: ["../src/**/*.stories.@(ts|tsx)"],
	async viteFinal(config) {
		const { default: tailwindcss } = await import("@tailwindcss/vite");
		const { mergeConfig } = await import("vite");
		return mergeConfig(config, { plugins: [tailwindcss()] });
	},
};

export default config;
