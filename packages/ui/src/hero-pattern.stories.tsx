import type { Meta, StoryObj } from "@storybook/react-vite";
import { HeroPattern } from "./hero-pattern";

const meta: Meta<typeof HeroPattern> = {
	title: "Components/HeroPattern",
	component: HeroPattern,
};

export default meta;
type Story = StoryObj<typeof HeroPattern>;

export const Default: Story = {
	render: () => (
		<div className="relative h-80 w-full overflow-hidden rounded-lg bg-white dark:bg-zinc-900">
			<HeroPattern />
			<div className="relative flex h-full items-center justify-center">
				<h1 className="text-3xl font-bold text-zinc-900 dark:text-white">Hero Section</h1>
			</div>
		</div>
	),
};
