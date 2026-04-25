import { memo } from "react"

type SvgProps = React.ComponentPropsWithoutRef<"svg">

export const AlignMiddleIcon = memo(({ className, ...props }: SvgProps) => {
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
      {/* Middle horizontal bar */}
      <line x1="3" y1="12" x2="21" y2="12" />
      {/* Left: arrow up and arrow down from middle */}
      <line x1="8" y1="4" x2="8" y2="20" />
      <polyline points="5,7 8,4 11,7" />
      <polyline points="5,17 8,20 11,17" />
      {/* Right: arrow up and arrow down from middle */}
      <line x1="16" y1="4" x2="16" y2="20" />
      <polyline points="13,7 16,4 19,7" />
      <polyline points="13,17 16,20 19,17" />
    </svg>
  )
})

AlignMiddleIcon.displayName = "AlignMiddleIcon"
