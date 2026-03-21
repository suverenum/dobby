import type { Meta, StoryObj } from "@storybook/react-vite";
import { Input } from "./input";

const meta: Meta<typeof Input> = {
	title: "Components/Input",
	component: Input,
	argTypes: {
		inputSize: {
			control: "select",
			options: ["default", "sm", "lg"],
		},
		type: {
			control: "select",
			options: ["text", "email", "password", "number", "search"],
		},
		disabled: { control: "boolean" },
		placeholder: { control: "text" },
	},
};

export default meta;
type Story = StoryObj<typeof Input>;

export const Default: Story = {
	args: { placeholder: "Enter text..." },
};

export const Email: Story = {
	args: { type: "email", placeholder: "you@example.com" },
};

export const Password: Story = {
	args: { type: "password", placeholder: "Password" },
};

export const Small: Story = {
	args: { inputSize: "sm", placeholder: "Small input" },
};

export const Large: Story = {
	args: { inputSize: "lg", placeholder: "Large input" },
};

export const Disabled: Story = {
	args: { placeholder: "Disabled", disabled: true },
};

export const WithValue: Story = {
	args: { defaultValue: "Hello World" },
};

export const AllSizes: Story = {
	render: () => (
		<div className="flex max-w-sm flex-col gap-3">
			<Input inputSize="sm" placeholder="Small" />
			<Input inputSize="default" placeholder="Default" />
			<Input inputSize="lg" placeholder="Large" />
		</div>
	),
};
