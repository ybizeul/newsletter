import { Extension } from "@tiptap/core"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    color: {
      setColor: (color: string) => ReturnType
      unsetColor: () => ReturnType
    }
  }
}

export const Color = Extension.create({
  name: "color",

  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          color: {
            default: null,
            parseHTML: (element: HTMLElement) =>
              element.style.color?.replace(/['"]+/g, "") || null,
            renderHTML: (attributes) => {
              if (!attributes.color) return {}
              return { style: `color: ${attributes.color}` }
            },
          },
        },
      },
    ]
  },

  addCommands() {
    return {
      setColor:
        (color: string) =>
        ({ chain }) =>
          chain().setMark("textStyle", { color }).run(),
      unsetColor:
        () =>
        ({ chain }) =>
          chain().setMark("textStyle", { color: null }).removeEmptyTextStyle().run(),
    }
  },
})
