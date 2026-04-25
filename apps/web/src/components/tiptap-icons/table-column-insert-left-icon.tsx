import { memo } from "react"

type SvgProps = React.ComponentPropsWithoutRef<"svg">

export const TableColumnInsertLeftIcon = memo(({ className, ...props }: SvgProps) => {
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
      {/* Plus at left */}
      <line x1="3" y1="12" x2="8" y2="12" />
      <line x1="5.5" y1="9.5" x2="5.5" y2="14.5" />
      {/* Table in right portion */}
      <rect x="11" y="3" width="10" height="18" rx="1.5" />
      <line x1="11" y1="9" x2="21" y2="9" />
      <line x1="11" y1="15" x2="21" y2="15" />
      <line x1="16" y1="3" x2="16" y2="21" />
    </svg>
  )
})

TableColumnInsertLeftIcon.displayName = "TableColumnInsertLeftIcon"
