import { forwardRef, useCallback, useMemo } from "react"

// --- Hooks ---
import { useTiptapEditor } from "@/hooks/use-tiptap-editor"

// --- Tiptap UI ---
import type { UseTextColorConfig } from "@/components/tiptap-ui/text-color-button/use-text-color"
import { useTextColor } from "@/components/tiptap-ui/text-color-button/use-text-color"

// --- UI Primitives ---
import type { ButtonProps } from "@/components/tiptap-ui-primitive/button"
import { Button } from "@/components/tiptap-ui-primitive/button"

// --- Styles ---
import "@/components/tiptap-ui/text-color-button/text-color-button.scss"

export interface TextColorButtonProps
  extends Omit<ButtonProps, "type">,
    UseTextColorConfig {
  text?: string
}

export const TextColorButton = forwardRef<
  HTMLButtonElement,
  TextColorButtonProps
>(
  (
    {
      editor: providedEditor,
      textColor,
      text,
      hideWhenUnavailable = false,
      onClick,
      children,
      style,
      ...buttonProps
    },
    ref
  ) => {
    const { editor } = useTiptapEditor(providedEditor)
    const { isVisible, canSetTextColor, isActive, handleSetColor, label } =
      useTextColor({
        editor,
        textColor,
        label: text || `Text color`,
        hideWhenUnavailable,
      })

    const handleClick = useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        handleSetColor()
      },
      [handleSetColor, onClick]
    )

    const buttonStyle = useMemo(
      () =>
        ({
          ...style,
          "--text-color-swatch": textColor,
        }) as React.CSSProperties,
      [textColor, style]
    )

    if (!isVisible) return null

    return (
      <Button
        type="button"
        variant="ghost"
        data-active-state={isActive ? "on" : "off"}
        role="button"
        tabIndex={-1}
        disabled={!canSetTextColor}
        data-disabled={!canSetTextColor}
        aria-label={label}
        aria-pressed={isActive}
        tooltip={label}
        onClick={handleClick}
        style={buttonStyle}
        {...buttonProps}
        ref={ref}
      >
        {children ?? (
          <>
            <span
              className="tiptap-button-text-color"
              style={
                {
                  "--text-color-swatch": textColor,
                } as React.CSSProperties
              }
            />
            {text && <span className="tiptap-button-text">{text}</span>}
          </>
        )}
      </Button>
    )
  }
)

TextColorButton.displayName = "TextColorButton"
