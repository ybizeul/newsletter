"use client"

import { useState } from "react"

import { useTiptapEditor } from "@/hooks/use-tiptap-editor"

import { Button } from "@/components/tiptap-ui-primitive/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
} from "@/components/tiptap-ui-primitive/dropdown-menu"
import { ChevronDownIcon } from "@/components/tiptap-icons/chevron-down-icon"

import type { Editor } from "@tiptap/react"

const FONT_SIZES = [
  { label: "Default", value: "" },
  { label: "12", value: "12px" },
  { label: "14", value: "14px" },
  { label: "16", value: "16px" },
  { label: "18", value: "18px" },
  { label: "20", value: "20px" },
  { label: "24", value: "24px" },
  { label: "28", value: "28px" },
  { label: "32", value: "32px" },
  { label: "36", value: "36px" },
  { label: "48", value: "48px" },
] as const

export interface FontSizeDropdownProps {
  editor?: Editor | null
  modal?: boolean
}

function getActiveFontSize(editor: Editor): string {
  const attrs = editor.getAttributes("textStyle")
  return (attrs.fontSize as string) || ""
}

export function FontSizeDropdown({
  editor: providedEditor,
  modal = false,
}: FontSizeDropdownProps) {
  const { editor } = useTiptapEditor(providedEditor)
  const [isOpen, setIsOpen] = useState(false)

  const activeSize = editor ? getActiveFontSize(editor) : ""
  const activeLabel =
    FONT_SIZES.find((s) => s.value === activeSize)?.label ?? (activeSize || "Default")

  return (
    <DropdownMenu modal={modal} open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          tooltip="Font size"
          aria-label="Font size"
          data-state={isOpen ? "open" : "closed"}
          style={{ minWidth: 56, justifyContent: "space-between", fontSize: 13 }}
        >
          <span>{activeLabel}</span>
          <ChevronDownIcon className="tiptap-button-icon tiptap-button-dropdown-small" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent>
        <DropdownMenuGroup>
          {FONT_SIZES.map((size) => (
            <DropdownMenuItem
              key={size.value}
              onSelect={() => {
                if (!editor) return
                if (size.value === "") {
                  editor.chain().focus().unsetFontSize().run()
                } else {
                  editor.chain().focus().setFontSize(size.value).run()
                }
              }}
            >
              {size.label}
              {activeSize === size.value && " ✓"}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
