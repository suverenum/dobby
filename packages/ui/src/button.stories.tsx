import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./button";

const meta: Meta<typeof Button> = {
	title: "Components/Button",
	component: Button,
	argTypes: {
		variant: {
			control: "select",
			options: ["default", "secondary", "filled", "outline", "text", "destructive", "ghost"],
		},
		size: {
			control: "select",
			options: ["default", "sm", "lg", "icon"],
		},
		disabled: { control: "boolean" },
	},
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Default: Story = {
	args: { children: "Button" },
};

export const Secondary: Story = {
	args: { children: "Secondary", variant: "secondary" },
};

export const Filled: Story = {
	args: { children: "Filled", variant: "filled" },
};

export const Outline: Story = {
	args: { children: "Outline", variant: "outline" },
};

export const Text: Story = {
	args: { children: "Text Link", variant: "text" },
};

export const Destructive: Story = {
	args: { children: "Delete", variant: "destructive" },
};

export const Ghost: Story = {
	args: { children: "Ghost", variant: "ghost" },
};

export const Small: Story = {
	args: { children: "Small", size: "sm" },
};

export const Large: Story = {
	args: { children: "Large", size: "lg" },
};

export const Disabled: Story = {
	args: { children: "Disabled", disabled: true },
};

export const AllVariants: Story = {
	render: () => (
		<div className="flex flex-wrap items-center gap-4">
			<Button variant="default">Default</Button>
			<Button variant="secondary">Secondary</Button>
			<Button variant="filled">Filled</Button>
			<Button variant="outline">Outline</Button>
			<Button variant="text">Text</Button>
			<Button variant="destructive">Destructive</Button>
			<Button variant="ghost">Ghost</Button>
		</div>
	),
};
