import { memo } from "react"

type SvgProps = React.ComponentPropsWithoutRef<"svg">

export const TableRowDeleteIcon = memo(({ className, ...props }: SvgProps) => {
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
      {/* 3-row, 2-col table */}
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="3" y1="15" x2="21" y2="15" />
      <line x1="10" y1="3" x2="10" y2="21" />
      <line x1="16" y1="3" x2="16" y2="21" />
      {/* X across the middle row band (y 9–15) */}
      <line x1="3" y1="9" x2="21" y2="15" />
      <line x1="21" y1="9" x2="3" y2="15" />
    </svg>
  )
})

TableRowDeleteIcon.displayName = "TableRowDeleteIcon"
