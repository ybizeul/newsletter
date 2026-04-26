import { forwardRef, useCallback, useState } from "react"
import { type Editor } from "@tiptap/react"
import { ColorPicker } from "@mantine/core"

// --- Hooks ---
import { useTiptapEditor } from "@/hooks/use-tiptap-editor"

// --- Icons ---
import { TextColorIcon } from "@/components/tiptap-icons/text-color-icon"

// --- UI Primitives ---
import type { ButtonProps } from "@/components/tiptap-ui-primitive/button"
import { Button } from "@/components/tiptap-ui-primitive/button"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/tiptap-ui-primitive/popover"

// --- Tiptap UI ---
import type { UseTextColorConfig } from "@/components/tiptap-ui/text-color-button"
import { useTextColor } from "@/components/tiptap-ui/text-color-button"

const TEXT_COLOR_SWATCHES = [
  "#868e96",
  "#fa5252",
  "#fd7e14",
  "#fab005",
  "#40c057",
  "#228be6",
  "#ae3ec9",
  "#e64980",
  "#212529",
  "#000000",
]

export interface TextColorPopoverContentProps {
  editor?: Editor | null
}

export interface TextColorPopoverProps
  extends Omit<ButtonProps, "type">,
    Pick<UseTextColorConfig, "editor" | "hideWhenUnavailable"> {}

export const TextColorPopoverButton = forwardRef<
  HTMLButtonElement,
  ButtonProps
>(({ className, children, ...props }, ref) => (
  <Button
    type="button"
    className={className}
    variant="ghost"
    data-appearance="default"
    role="button"
    tabIndex={-1}
    aria-label="Text color"
    tooltip="Text color"
    ref={ref}
    {...props}
  >
    {children ?? <TextColorIcon className="tiptap-button-icon" />}
  </Button>
))

TextColorPopoverButton.displayName = "TextColorPopoverButton"

export function TextColorPopoverContent({
  editor: providedEditor,
}: TextColorPopoverContentProps) {
  const { editor } = useTiptapEditor(providedEditor)
  const [color, setColor] = useState("#000000")

  const handleChangeEnd = useCallback(
    (value: string) => {
      setColor(value)
      if (!editor || !value) return
      editor.chain().focus().setColor(value).run()
    },
    [editor]
  )

  return (
    <div style={{ padding: 8 }}>
      <ColorPicker
        format="hex"
        value={color}
        onChange={setColor}
        onChangeEnd={handleChangeEnd}
        swatches={TEXT_COLOR_SWATCHES}
        size="sm"
      />
    </div>
  )
}

export function TextColorPopover({
  editor: providedEditor,
  hideWhenUnavailable = false,
  ...props
}: TextColorPopoverProps) {
  const { editor } = useTiptapEditor(providedEditor)
  const [isOpen, setIsOpen] = useState(false)
  const { isVisible, canSetTextColor, isActive, label, Icon } = useTextColor({
    editor,
    hideWhenUnavailable,
  })

  if (!isVisible) return null

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <TextColorPopoverButton
          disabled={!canSetTextColor}
          data-active-state={isActive ? "on" : "off"}
          data-disabled={!canSetTextColor}
          aria-pressed={isActive}
          aria-label={label}
          tooltip={label}
          {...props}
        >
          <Icon className="tiptap-button-icon" />
        </TextColorPopoverButton>
      </PopoverTrigger>
      <PopoverContent aria-label="Text colors">
        <TextColorPopoverContent editor={editor} />
      </PopoverContent>
    </Popover>
  )
}

export default TextColorPopover
