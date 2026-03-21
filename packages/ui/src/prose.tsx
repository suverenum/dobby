import { cn } from "@template/utils";
import type { ComponentProps, ElementType } from "react";

type ProseProps<T extends ElementType = "div"> = Omit<ComponentProps<T>, "as" | "className"> & {
	as?: T;
	className?: string;
};

function Prose<T extends ElementType = "div">({ as, className, ...props }: ProseProps<T>) {
	const Component = as ?? "div";
	return <Component className={cn("prose dark:prose-invert", className)} {...props} />;
}

export type { ProseProps };
export { Prose };
