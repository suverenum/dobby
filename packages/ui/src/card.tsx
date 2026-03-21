import { cn } from "@template/utils";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

const cardVariants = cva(
	"rounded-lg border border-zinc-900/10 bg-white text-zinc-900 shadow-sm dark:border-white/10 dark:bg-zinc-800/50 dark:text-white",
	{
		variants: {
			padding: {
				default: "p-6",
				none: "",
				sm: "p-4",
				lg: "p-8",
			},
		},
		defaultVariants: {
			padding: "default",
		},
	},
);

type CardProps = ComponentProps<"div"> & VariantProps<typeof cardVariants>;

function Card({ className, padding, ref, ...props }: CardProps) {
	return <div ref={ref} className={cn(cardVariants({ padding, className }))} {...props} />;
}

function CardHeader({ className, ref, ...props }: ComponentProps<"div">) {
	return <div ref={ref} className={cn("flex flex-col space-y-1.5", className)} {...props} />;
}

function CardTitle({ className, ref, ...props }: ComponentProps<"h3">) {
	return (
		<h3
			ref={ref}
			className={cn("text-2xl font-semibold leading-none tracking-tight", className)}
			{...props}
		/>
	);
}

function CardDescription({ className, ref, ...props }: ComponentProps<"p">) {
	return (
		<p ref={ref} className={cn("text-sm text-zinc-600 dark:text-zinc-400", className)} {...props} />
	);
}

function CardContent({ className, ref, ...props }: ComponentProps<"div">) {
	return <div ref={ref} className={cn("pt-0", className)} {...props} />;
}

function CardFooter({ className, ref, ...props }: ComponentProps<"div">) {
	return <div ref={ref} className={cn("flex items-center pt-0", className)} {...props} />;
}

export type { CardProps };
export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, cardVariants };
