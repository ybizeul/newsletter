import { memo } from "react"

type SvgProps = React.ComponentPropsWithoutRef<"svg">

export const AlignTopIcon = memo(({ className, ...props }: SvgProps) => {
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
      {/* Top horizontal bar */}
      <line x1="3" y1="4" x2="21" y2="4" />
      {/* Left arrow down from top */}
      <line x1="8" y1="7" x2="8" y2="20" />
      <polyline points="5,10 8,7 11,10" />
      {/* Right arrow down from top */}
      <line x1="16" y1="7" x2="16" y2="20" />
      <polyline points="13,10 16,7 19,10" />
    </svg>
  )
})

AlignTopIcon.displayName = "AlignTopIcon"
