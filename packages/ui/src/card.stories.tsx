import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";

const meta: Meta<typeof Card> = {
	title: "Components/Card",
	component: Card,
	argTypes: {
		padding: {
			control: "select",
			options: ["default", "none", "sm", "lg"],
		},
	},
	decorators: [(Story) => <div className="max-w-sm">{Story()}</div>],
};

export default meta;
type Story = StoryObj<typeof Card>;

export const Default: Story = {
	render: () => (
		<Card>
			<CardHeader>
				<CardTitle>Card Title</CardTitle>
				<CardDescription>Card description goes here.</CardDescription>
			</CardHeader>
			<CardContent>
				<p>Card content with some text.</p>
			</CardContent>
			<CardFooter>
				<Button size="sm">Action</Button>
			</CardFooter>
		</Card>
	),
};

export const SmallPadding: Story = {
	render: () => (
		<Card padding="sm">
			<CardHeader>
				<CardTitle>Compact Card</CardTitle>
				<CardDescription>With small padding.</CardDescription>
			</CardHeader>
			<CardContent>
				<p>Less space around content.</p>
			</CardContent>
		</Card>
	),
};

export const LargePadding: Story = {
	render: () => (
		<Card padding="lg">
			<CardHeader>
				<CardTitle>Spacious Card</CardTitle>
				<CardDescription>With large padding.</CardDescription>
			</CardHeader>
			<CardContent>
				<p>More breathing room.</p>
			</CardContent>
		</Card>
	),
};

export const NoPadding: Story = {
	render: () => (
		<Card padding="none">
			<div className="p-6">
				<CardHeader>
					<CardTitle>No Padding</CardTitle>
					<CardDescription>Custom padding per section.</CardDescription>
				</CardHeader>
			</div>
		</Card>
	),
};
