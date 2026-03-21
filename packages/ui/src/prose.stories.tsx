import type { Meta, StoryObj } from "@storybook/react-vite";
import { Prose } from "./prose";

const meta: Meta<typeof Prose> = {
	title: "Components/Prose",
	component: Prose,
	decorators: [(Story) => <div className="max-w-2xl">{Story()}</div>],
};

export default meta;
type Story = StoryObj<typeof Prose>;

export const Default: Story = {
	render: () => (
		<Prose>
			<h1>Heading 1</h1>
			<p>
				This is a paragraph of text styled with the Prose component. It uses Tailwind Typography to
				provide beautiful typographic defaults for long-form content.
			</p>
			<h2>Heading 2</h2>
			<p>
				The component supports dark mode automatically via <code>prose-invert</code>.
			</p>
			<ul>
				<li>First item</li>
				<li>Second item</li>
				<li>Third item</li>
			</ul>
			<blockquote>This is a blockquote with some important information.</blockquote>
		</Prose>
	),
};
