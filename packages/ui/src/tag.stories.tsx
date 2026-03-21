import type { Meta, StoryObj } from "@storybook/react-vite";
import { Tag } from "./tag";

const meta: Meta<typeof Tag> = {
	title: "Components/Tag",
	component: Tag,
	argTypes: {
		variant: { control: "select", options: ["small", "medium"] },
		color: { control: "select", options: ["emerald", "sky", "amber", "rose", "zinc"] },
	},
};

export default meta;
type Story = StoryObj<typeof Tag>;

export const Default: Story = {
	args: { children: "GET", color: "emerald" },
};

export const Sky: Story = {
	args: { children: "POST", color: "sky" },
};

export const Amber: Story = {
	args: { children: "PUT", color: "amber" },
};

export const Rose: Story = {
	args: { children: "DELETE", color: "rose" },
};

export const Zinc: Story = {
	args: { children: "PATCH", color: "zinc" },
};

export const Small: Story = {
	args: { children: "GET", variant: "small", color: "emerald" },
};

export const AllColors: Story = {
	render: () => (
		<div className="flex items-center gap-3">
			<Tag color="emerald">GET</Tag>
			<Tag color="sky">POST</Tag>
			<Tag color="amber">PUT</Tag>
			<Tag color="rose">DELETE</Tag>
			<Tag color="zinc">PATCH</Tag>
		</div>
	),
};
