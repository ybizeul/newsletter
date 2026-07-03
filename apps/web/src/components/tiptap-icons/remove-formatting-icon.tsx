import { memo } from "react"

type SvgProps = React.ComponentPropsWithoutRef<"svg">

export const RemoveFormattingIcon = memo(({ className, ...props }: SvgProps) => {
  return (
    <svg
      width="24"
      height="24"
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M3.27 5L2 6.27l6.97 6.97L6.5 19h3l1.57-3.97L16.73 21 18 19.73 3.27 5zM6 5v.18L8.82 8h2.4l-.72 1.68 2.1 2.1L14.21 8H20V5H6z" />
    </svg>
  )
})

RemoveFormattingIcon.displayName = "RemoveFormattingIcon"
