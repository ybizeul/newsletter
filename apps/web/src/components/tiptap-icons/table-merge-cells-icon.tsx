import { memo } from "react"

type SvgProps = React.ComponentPropsWithoutRef<"svg">

/** Represents merged cells: a 2×2 grid where the top row has no vertical divider (merged). */
export const TableMergeCellsIcon = memo(({ className, ...props }: SvgProps) => {
  return (
    <svg
      width="24"
      height="24"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {/* Outer border */}
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
      {/* Horizontal divider */}
      <line x1="3" y1="12" x2="21" y2="12" />
      {/* Vertical divider only in the bottom half — top row is merged */}
      <line x1="12" y1="12" x2="12" y2="21" />
    </svg>
  )
})

TableMergeCellsIcon.displayName = "TableMergeCellsIcon"
