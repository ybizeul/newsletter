import { memo } from "react"

type SvgProps = React.ComponentPropsWithoutRef<"svg">

export const TableRowInsertBottomIcon = memo(({ className, ...props }: SvgProps) => {
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
      {/* Table in top portion */}
      <rect x="3" y="3" width="18" height="10" rx="1.5" />
      <line x1="3" y1="8" x2="21" y2="8" />
      <line x1="10" y1="3" x2="10" y2="13" />
      <line x1="16" y1="3" x2="16" y2="13" />
      {/* Plus at bottom */}
      <line x1="12" y1="16" x2="12" y2="21" />
      <line x1="9.5" y1="18.5" x2="14.5" y2="18.5" />
    </svg>
  )
})

TableRowInsertBottomIcon.displayName = "TableRowInsertBottomIcon"
