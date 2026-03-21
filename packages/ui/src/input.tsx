import { cn } from "@suverenum/utils";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

const inputVariants = cva(
	"flex w-full rounded-md border border-zinc-900/10 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-zinc-800/40 dark:text-white dark:placeholder:text-zinc-500",
	{
		variants: {
			inputSize: {
				default: "h-10",
				sm: "h-9",
				lg: "h-11",
			},
		},
		defaultVariants: {
			inputSize: "default",
		},
	},
);

type InputProps = ComponentProps<"input"> & VariantProps<typeof inputVariants>;

function Input({ className, inputSize, type, ref, ...props }: InputProps) {
	return (
		<input
			type={type}
			className={cn(inputVariants({ inputSize, className }))}
			ref={ref}
			{...props}
		/>
	);
}

export type { InputProps };
export { Input, inputVariants };
