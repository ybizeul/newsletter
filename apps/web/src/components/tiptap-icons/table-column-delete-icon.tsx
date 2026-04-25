import { memo } from "react"

type SvgProps = React.ComponentPropsWithoutRef<"svg">

export const TableColumnDeleteIcon = memo(({ className, ...props }: SvgProps) => {
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
      {/* 2-row, 3-col table */}
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
      <line x1="9" y1="3" x2="9" y2="21" />
      <line x1="15" y1="3" x2="15" y2="21" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <line x1="3" y1="16" x2="21" y2="16" />
      {/* X across the middle column band (x 9–15) */}
      <line x1="9" y1="3" x2="15" y2="21" />
      <line x1="15" y1="3" x2="9" y2="21" />
    </svg>
  )
})

TableColumnDeleteIcon.displayName = "TableColumnDeleteIcon"
