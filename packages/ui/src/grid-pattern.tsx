import { useId } from "react";

type GridPatternProps = React.ComponentPropsWithoutRef<"svg"> & {
	width: number;
	height: number;
	x: string | number;
	y: string | number;
	squares: Array<[x: number, y: number]>;
};

function GridPattern({ width, height, x, y, squares, ...props }: GridPatternProps) {
	const patternId = useId();

	return (
		<svg aria-hidden="true" {...props}>
			<defs>
				<pattern
					id={patternId}
					width={width}
					height={height}
					patternUnits="userSpaceOnUse"
					x={x}
					y={y}
				>
					<path d={`M.5 ${height}V.5H${width}`} fill="none" />
				</pattern>
			</defs>
			<rect width="100%" height="100%" strokeWidth={0} fill={`url(#${patternId})`} />
			{squares && (
				<svg x={x} y={y} aria-hidden="true" className="overflow-visible">
					{squares.map(([sx, sy]) => (
						<rect
							strokeWidth="0"
							key={`${sx}-${sy}`}
							width={width + 1}
							height={height + 1}
							x={sx * width}
							y={sy * height}
						/>
					))}
				</svg>
			)}
		</svg>
	);
}

export type { GridPatternProps };
export { GridPattern };
