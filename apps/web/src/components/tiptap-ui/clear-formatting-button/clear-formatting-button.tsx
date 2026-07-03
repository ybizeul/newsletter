"use client"

import { forwardRef, useCallback } from "react"

// --- Hooks ---
import { useTiptapEditor } from "@/hooks/use-tiptap-editor"

// --- Tiptap UI ---
import type { UseClearFormattingConfig } from "@/components/tiptap-ui/clear-formatting-button"
import { useClearFormatting } from "@/components/tiptap-ui/clear-formatting-button"

// --- UI Primitives ---
import type { ButtonProps } from "@/components/tiptap-ui-primitive/button"
import { Button } from "@/components/tiptap-ui-primitive/button"

export interface ClearFormattingButtonProps
  extends Omit<ButtonProps, "type">,
    UseClearFormattingConfig {
  /**
   * Optional text to display alongside the icon.
   */
  text?: string
}

/**
 * Button component for clearing all formatting (except links) in a Tiptap editor.
 *
 * For custom button implementations, use the `useClearFormatting` hook instead.
 */
export const ClearFormattingButton = forwardRef<
  HTMLButtonElement,
  ClearFormattingButtonProps
>(
  (
    {
      editor: providedEditor,
      text,
      onCleared,
      onClick,
      children,
      ...buttonProps
    },
    ref
  ) => {
    const { editor } = useTiptapEditor(providedEditor)
    const { isVisible, canClear, handleClear, label, Icon } =
      useClearFormatting({ editor, onCleared })

    const handleClick = useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        handleClear()
      },
      [handleClear, onClick]
    )

    if (!isVisible) {
      return null
    }

    return (
      <Button
        type="button"
        disabled={!canClear}
        variant="ghost"
        data-disabled={!canClear}
        role="button"
        tabIndex={-1}
        aria-label={label}
        tooltip={label}
        onClick={handleClick}
        {...buttonProps}
        ref={ref}
      >
        {children ?? (
          <>
            <Icon className="tiptap-button-icon" />
            {text && <span className="tiptap-button-text">{text}</span>}
          </>
        )}
      </Button>
    )
  }
)

ClearFormattingButton.displayName = "ClearFormattingButton"
