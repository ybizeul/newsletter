import { memo } from "react"

type SvgProps = React.ComponentPropsWithoutRef<"svg">

export const TextColorIcon = memo(({ className, ...props }: SvgProps) => {
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
      <path
        d="M11.05 3a1 1 0 0 0-.943.667L5.362 16H4a1 1 0 1 0 0 2h4a1 1 0 1 0 0-2h-.638l1.5-4h6.276l1.5 4H16a1 1 0 1 0 0 2h4a1 1 0 1 0 0-2h-1.362L13.893 3.667A1 1 0 0 0 12.95 3h-1.9Zm2.588 9H10.362l1.638-4.362L13.638 12Z"
        fill="currentColor"
      />
      <rect x="3" y="20" width="18" height="2.5" rx="1" fill="var(--text-color-indicator, currentColor)" />
    </svg>
  )
})

TextColorIcon.displayName = "TextColorIcon"
