import { memo } from "react"

type SvgProps = React.ComponentPropsWithoutRef<"svg">

export const AlignBottomIcon = memo(({ className, ...props }: SvgProps) => {
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
      {/* Bottom horizontal bar */}
      <line x1="3" y1="20" x2="21" y2="20" />
      {/* Left arrow up to bottom */}
      <line x1="8" y1="4" x2="8" y2="17" />
      <polyline points="5,14 8,17 11,14" />
      {/* Right arrow up to bottom */}
      <line x1="16" y1="4" x2="16" y2="17" />
      <polyline points="13,14 16,17 19,14" />
    </svg>
  )
})

AlignBottomIcon.displayName = "AlignBottomIcon"
