import { type ClipboardEvent, useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  ColorPicker,
  ColorSwatch,
  Group,
  Input,
  Modal,
  Paper,
  Popover,
  ScrollArea,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  UnstyledButton
} from "@mantine/core";
import { IconFilePlus, IconPencil, IconRefresh, IconTrash } from "@tabler/icons-react";
import * as TablerIcons from "@tabler/icons-react";
import MDEditor from "@uiw/react-md-editor";
import { renderToStaticMarkup } from "react-dom/server";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";
import "../styles/markdown-editor.css";
import { createArticle, deleteArticle, listArticles, updateArticle } from "../lib/api";
import type { Article } from "../types/domain";

const DEMO_AUTHOR_ID = "demo-user";
const TABLER_ICON_MAP = TablerIcons as unknown as Record<string, React.ComponentType<{ size?: number }>>;

const DEFAULT_TOPIC_ICON_BG = "#228be6";
const DEFAULT_TOPIC_ICON_STROKE = "#ffffff";

function extractTopicIconBackgroundColor(illustration?: string): string {
  if (!illustration || !illustration.startsWith("data:image/svg+xml,")) {
    return DEFAULT_TOPIC_ICON_BG;
  }

  try {
    const decoded = decodeURIComponent(illustration.replace("data:image/svg+xml,", ""));
    const match = decoded.match(/<circle[^>]*fill="([^"]+)"/i);
    return match?.[1] ?? DEFAULT_TOPIC_ICON_BG;
  } catch {
    return DEFAULT_TOPIC_ICON_BG;
  }
}

function extractTopicIconStrokeColor(illustration?: string): string {
  if (!illustration || !illustration.startsWith("data:image/svg+xml,")) {
    return DEFAULT_TOPIC_ICON_STROKE;
  }

  try {
    const decoded = decodeURIComponent(illustration.replace("data:image/svg+xml,", ""));
    const match = decoded.match(/<g[^>]*color="([^"]+)"/i);
    return match?.[1] ?? DEFAULT_TOPIC_ICON_STROKE;
  } catch {
    return DEFAULT_TOPIC_ICON_STROKE;
  }
}

function buildTopicIconIllustration(iconName: string, circleColor: string, strokeColor: string): string {
  const IconComponent = TABLER_ICON_MAP[iconName];
  if (!IconComponent) {
    return "";
  }

  const iconSvgRaw = renderToStaticMarkup(<IconComponent size={22} />);
  const iconInner = iconSvgRaw
    .replace(/^<svg[^>]*>/i, "")
    .replace(/<\/svg>$/i, "");
  const iconSvg = `<g transform="translate(8 8)" color="${strokeColor}" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${iconInner}</g>`;

  const finalSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40" role="img" aria-label="${iconName}"><circle cx="20" cy="20" r="20" fill="${circleColor}"/>${iconSvg}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(finalSvg)}`;
}

function resolveTablerIconName(input: string): string {
  const raw = input.trim();
  if (!raw) {
    return "";
  }

  if (TABLER_ICON_MAP[raw]) {
    return raw;
  }

  const normalized = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!normalized) {
    return "";
  }

  const candidates = Object.keys(TABLER_ICON_MAP).filter((name) => name.startsWith("Icon"));

  const exact = candidates.find((name) => name.toLowerCase() === normalized);
  if (exact) {
    return exact;
  }

  const withoutPrefix = candidates.find(
    (name) => name.replace(/^Icon/, "").toLowerCase() === normalized
  );
  if (withoutPrefix) {
    return withoutPrefix;
  }

  const partial = candidates.find((name) =>
    name.replace(/^Icon/, "").toLowerCase().includes(normalized)
  );
  return partial ?? "";
}

export default function ArticlesPage() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [selectedArticleId, setSelectedArticleID] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [topicIcon, setTopicIcon] = useState("");
  const [topicIconBgColor, setTopicIconBgColor] = useState(DEFAULT_TOPIC_ICON_BG);
  const [topicIconStrokeColor, setTopicIconStrokeColor] = useState(DEFAULT_TOPIC_ICON_STROKE);
  const [isBgPickerOpen, setIsBgPickerOpen] = useState(false);
  const [isStrokePickerOpen, setIsStrokePickerOpen] = useState(false);
  const [isIconBrowserOpen, setIsIconBrowserOpen] = useState(false);
  const [iconSearch, setIconSearch] = useState("");
  const [pastedImageMap, setPastedImageMap] = useState<Record<string, string>>({});
  const [editingId, setEditingID] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadArticles = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const items = await listArticles();
      setArticles(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load articles");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadArticles();
  }, []);

  const resetForm = () => {
    setTitle("");
    setMarkdown("");
    setTopicIcon("");
    setTopicIconBgColor(DEFAULT_TOPIC_ICON_BG);
    setTopicIconStrokeColor(DEFAULT_TOPIC_ICON_STROKE);
    setPastedImageMap({});
    setEditingID(null);
    setSelectedArticleID(null);
  };

  const resolvePastedImageTokens = (input: string): string =>
    input.replace(/paste:\/\/([a-zA-Z0-9_-]+)/g, (_, token) => pastedImageMap[token] ?? "");

  const normalizeMarkdownForEditor = (
    input: string
  ): { normalized: string; imageMap: Record<string, string> } => {
    const imageMap: Record<string, string> = {};

    const normalized = input.replace(/!\[([^\]]*)\]\((data:image\/[^)]+)\)/g, (_, alt, dataUrl) => {
      const token = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      imageMap[token] = dataUrl;
      return `![${alt}](paste://${token})`;
    });

    return { normalized, imageMap };
  };

  const resolveImageSource = (src: string | undefined) => {
    if (!src) {
      return "";
    }
    if (src.startsWith("paste://")) {
      const token = src.slice("paste://".length);
      return pastedImageMap[token] ?? "";
    }
    return src;
  };

  const onEdit = (article: Article) => {
    setEditingID(article.id);
    setSelectedArticleID(article.id);
    setTitle(article.title);
    const normalized = normalizeMarkdownForEditor(article.markdown);
    setMarkdown(normalized.normalized);
    setPastedImageMap(normalized.imageMap);
    setTopicIcon(article.topicIcon ?? "");
    setTopicIconBgColor(extractTopicIconBackgroundColor(article.illustration));
    setTopicIconStrokeColor(extractTopicIconStrokeColor(article.illustration));
  };

  const resolvedTopicIconName = useMemo(() => resolveTablerIconName(topicIcon), [topicIcon]);

  const generatedTopicIconIllustration = useMemo(
    () => buildTopicIconIllustration(resolvedTopicIconName, topicIconBgColor, topicIconStrokeColor),
    [resolvedTopicIconName, topicIconBgColor, topicIconStrokeColor]
  );

  useEffect(() => {
    if (articles.length === 0) {
      return;
    }

    if (selectedArticleId === null && editingId === null) {
      onEdit(articles[0]);
      return;
    }

    if (selectedArticleId && !articles.some((article) => article.id === selectedArticleId)) {
      resetForm();
    }
  }, [articles]);

  const onSubmit = async () => {
    if (!title.trim()) {
      setError("Title is required");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      if (editingId) {
        const updated = await updateArticle(editingId, {
          title: title.trim(),
          markdown: resolvePastedImageTokens(markdown.trim()),
          topicIcon: topicIcon.trim(),
          illustration: generatedTopicIconIllustration
        });

        setArticles((current) =>
          current.map((article) => (article.id === editingId ? updated : article))
        );
        setSelectedArticleID(updated.id);
      } else {
        const created = await createArticle({
          authorId: DEMO_AUTHOR_ID,
          title: title.trim(),
          markdown: resolvePastedImageTokens(markdown.trim()),
          topicIcon: topicIcon.trim(),
          illustration: generatedTopicIconIllustration
        });

        setArticles((current) => [created, ...current]);
        setSelectedArticleID(created.id);
        setEditingID(created.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save article");
    } finally {
      setIsSubmitting(false);
    }
  };

  const onDelete = async (articleId: string) => {
    const ok = window.confirm("Delete this article?");
    if (!ok) {
      return;
    }

    setError(null);
    try {
      await deleteArticle(articleId);
      setArticles((current) => {
        const next = current.filter((article) => article.id !== articleId);
        if (selectedArticleId === articleId) {
          if (next.length > 0) {
            onEdit(next[0]);
          } else {
            resetForm();
          }
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete article");
    }
  };

  const insertAtCursor = (
    target: HTMLTextAreaElement,
    currentText: string,
    insertion: string
  ): string => {
    const start = target.selectionStart ?? currentText.length;
    const end = target.selectionEnd ?? currentText.length;
    const next = currentText.slice(0, start) + insertion + currentText.slice(end);

    requestAnimationFrame(() => {
      const pos = start + insertion.length;
      target.selectionStart = pos;
      target.selectionEnd = pos;
    });

    return next;
  };

  const insertImageMarkdownFromFile = (target: HTMLTextAreaElement, file: File) => {
    if (!file.type.startsWith("image/")) {
      setError("Only image files are supported");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        const dataURL = reader.result;
        const token = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        setPastedImageMap((current) => ({ ...current, [token]: dataURL }));
        setMarkdown((current) =>
          insertAtCursor(target, current, `\n![Pasted image](paste://${token})\n`)
        );
      }
    };
    reader.onerror = () => {
      setError("Failed to read image file");
    };
    reader.readAsDataURL(file);
  };

  const onPasteMarkdown = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData.items;

    for (const item of items) {
      if (item.type.startsWith("image/")) {
        event.preventDefault();
        const file = item.getAsFile();
        if (file) {
          setError(null);
          insertImageMarkdownFromFile(event.currentTarget, file);
          return;
        }
      }
    }

    const pastedText = event.clipboardData.getData("text/plain").trim();
    if (/(https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg))/i.test(pastedText)) {
      event.preventDefault();
      setError(null);
      setMarkdown((current) =>
        insertAtCursor(event.currentTarget, current, `\n![Pasted image](${pastedText})\n`)
      );
    }
  };

  const filteredIconNames = useMemo(() => {
    const query = iconSearch.trim().toLowerCase();
    return Object.keys(TablerIcons)
      .filter((name) => name.startsWith("Icon") && name !== "Icon")
      .filter((name) => (query ? name.toLowerCase().includes(query) : true))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 300);
  }, [iconSearch]);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "340px 1fr",
        gap: 0,
        height: "calc(100vh - 120px)",
        minHeight: 560
      }}
    >
      <div style={{ borderRight: "1px solid #e9ecef", overflow: "hidden" }}>
        <Group justify="space-between" p="sm" style={{ borderBottom: "1px solid #e9ecef" }}>
          <Text fw={600}>Articles ({articles.length})</Text>
          <Group gap="xs">
            <ActionIcon variant="light" onClick={resetForm} title="New article">
              <IconFilePlus size={16} />
            </ActionIcon>
            <ActionIcon variant="light" onClick={() => void loadArticles()} loading={isLoading} title="Refresh">
              <IconRefresh size={16} />
            </ActionIcon>
          </Group>
        </Group>

        <ScrollArea h="calc(100% - 52px)" offsetScrollbars>
          <Stack gap={0}>
            {articles.map((article) => (
              <div
                key={article.id}
                onClick={() => onEdit(article)}
                style={{
                  padding: 12,
                  borderBottom: "1px solid #f1f3f5",
                  cursor: "pointer",
                  backgroundColor: selectedArticleId === article.id ? "#f1fbff" : "transparent"
                }}
              >
                <Group justify="space-between" align="flex-start">
                  <Stack gap={4} style={{ flex: 1 }}>
                    <Text fw={600} lineClamp={1}>
                      {article.title}
                    </Text>
                    <Badge variant="light" size="sm" w="fit-content">
                      {article.status}
                    </Badge>
                  </Stack>
                  <ActionIcon
                    color="red"
                    variant="subtle"
                    onClick={(event) => {
                      event.stopPropagation();
                      void onDelete(article.id);
                    }}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              </div>
            ))}
            {articles.length === 0 ? (
              <Text c="dimmed" size="sm" p="md">
                No articles yet.
              </Text>
            ) : null}
          </Stack>
        </ScrollArea>
      </div>

      <div style={{ padding: 12, overflow: "auto" }}>
        <Stack>
          <Group justify="space-between">
            <Text fw={700}>{editingId ? "Edit Article" : "New Article"}</Text>
            {editingId ? (
              <Group gap="xs">
                <Button variant="default" size="xs" onClick={resetForm}>
                  Cancel
                </Button>
                <Button color="red" variant="light" size="xs" onClick={() => void onDelete(editingId)}>
                  Delete
                </Button>
              </Group>
            ) : null}
          </Group>

          <Group align="flex-end" wrap="nowrap">
            <UnstyledButton
              onClick={() => setIsIconBrowserOpen(true)}
              aria-label="Select topic icon"
              style={{
                width: 40,
                height: 40,
                borderRadius: 9999,
                border: "1px solid #dee2e6",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: generatedTopicIconIllustration ? "#fff" : "#f8f9fa",
                cursor: "pointer",
                padding: 0,
                overflow: "hidden",
                flexShrink: 0
              }}
            >
              {generatedTopicIconIllustration ? (
                <Box
                  component="img"
                  src={generatedTopicIconIllustration}
                  alt="Topic icon preview"
                  w={40}
                  h={40}
                  style={{ display: "block" }}
                />
              ) : (
                <Text size="xs" c="dimmed">
                  +
                </Text>
              )}
            </UnstyledButton>

            <TextInput
              style={{ flex: 1 }}
              label="Title"
              description="Internal article title used in the article list and newsletter sections."
              placeholder="Article title"
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
          </Group>

          <Input.Wrapper
            label="Content"
            description="Compose the article body. Pasted images are embedded inline."
          >
            <div data-color-mode="light">
              <MDEditor
                className="markdown-editor-monospace"
                value={markdown}
                onChange={(value) => setMarkdown(value ?? "")}
                preview="live"
                height={350}
                textareaProps={{
                  placeholder: "Write your article content (paste image inline)",
                  onPaste: onPasteMarkdown,
                  style: {
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace",
                    fontSize: 14,
                    lineHeight: 1.6
                  }
                }}
                previewOptions={{
                  components: {
                    img: ({ src, alt }) => {
                      const resolvedSrc = resolveImageSource(src);
                      if (!resolvedSrc) {
                        return null;
                      }
                      return (
                        <img
                          src={resolvedSrc}
                          alt={alt ?? "inline"}
                          style={{ maxWidth: "100%", height: "auto", borderRadius: 8 }}
                        />
                      );
                    }
                  }
                }}
              />
            </div>
          </Input.Wrapper>

          <Group justify="flex-end">
            <Button leftSection={<IconPencil size={16} />} onClick={() => void onSubmit()} loading={isSubmitting}>
              {editingId ? "Save Changes" : "Create Article"}
            </Button>
          </Group>

          {error ? <Text c="red">{error}</Text> : null}
        </Stack>
      </div>

      <Modal
        opened={isIconBrowserOpen}
        onClose={() => setIsIconBrowserOpen(false)}
        title="Icon designer"
        size="xl"
      >
        <Stack>
          <Paper withBorder p="sm" radius="md">
            <Stack gap="sm" align="center">
              <UnstyledButton
                onClick={() => setTopicIcon("")}
                style={{
                  width: 96,
                  height: 96,
                  borderRadius: 9999,
                  border: "1px solid #dee2e6",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: generatedTopicIconIllustration ? "#fff" : "#f8f9fa",
                  padding: 0,
                  overflow: "hidden",
                  cursor: "pointer"
                }}
              >
                {generatedTopicIconIllustration ? (
                  <Box
                    component="img"
                    src={generatedTopicIconIllustration}
                    alt="Current icon preview"
                    w={96}
                    h={96}
                    style={{ display: "block" }}
                  />
                ) : (
                  <Text size="xl" c="dimmed">
                    +
                  </Text>
                )}
              </UnstyledButton>

              <Group gap="md" align="center" justify="center">
                <Popover opened={isBgPickerOpen} onChange={setIsBgPickerOpen} position="bottom" shadow="md">
                  <Popover.Target>
                    <UnstyledButton onClick={() => setIsBgPickerOpen((v) => !v)}>
                      <Group gap={8}>
                        <ColorSwatch color={topicIconBgColor} size={22} />
                        <Text size="sm">Background</Text>
                      </Group>
                    </UnstyledButton>
                  </Popover.Target>
                  <Popover.Dropdown>
                    <ColorPicker
                      format="hex"
                      value={topicIconBgColor}
                      onChange={setTopicIconBgColor}
                      swatches={["#228be6", "#15aabf", "#40c057", "#fab005", "#fd7e14", "#fa5252", "#ae3ec9", "#495057"]}
                    />
                  </Popover.Dropdown>
                </Popover>

                <Popover opened={isStrokePickerOpen} onChange={setIsStrokePickerOpen} position="bottom" shadow="md">
                  <Popover.Target>
                    <UnstyledButton onClick={() => setIsStrokePickerOpen((v) => !v)}>
                      <Group gap={8}>
                        <ColorSwatch color={topicIconStrokeColor} size={22} />
                        <Text size="sm">Stroke</Text>
                      </Group>
                    </UnstyledButton>
                  </Popover.Target>
                  <Popover.Dropdown>
                    <ColorPicker
                      format="hex"
                      value={topicIconStrokeColor}
                      onChange={setTopicIconStrokeColor}
                      swatches={["#ffffff", "#f8f9fa", "#dee2e6", "#212529", "#000000"]}
                    />
                  </Popover.Dropdown>
                </Popover>
              </Group>
            </Stack>

            <Group justify="flex-end" mt="sm">
              <Group gap="xs">
                <Button variant="subtle" color="gray" onClick={() => setTopicIcon("")}>
                  Clear icon
                </Button>
                <Button variant="default" onClick={() => setIsIconBrowserOpen(false)}>
                  Done
                </Button>
              </Group>
            </Group>
          </Paper>

          <TextInput
            label="Search icon"
            description="Filter Tabler icon names before selecting one for the topic icon."
            placeholder="Search icon name (e.g. sparkles, mail, chart)"
            value={iconSearch}
            onChange={(event) => setIconSearch(event.currentTarget.value)}
          />

          <ScrollArea h={420}>
            <SimpleGrid cols={{ base: 2, sm: 3, md: 4 }} spacing="xs">
              {filteredIconNames.map((iconName) => {
                const IconComponent = TABLER_ICON_MAP[iconName];

                if (!IconComponent) {
                  return null;
                }

                const isSelected = topicIcon === iconName;
                return (
                  <UnstyledButton
                    key={iconName}
                    onClick={() => {
                      setTopicIcon(iconName);
                    }}
                    style={{
                      border: isSelected ? "1px solid #228be6" : "1px solid #dee2e6",
                      borderRadius: 8,
                      background: isSelected ? "#e7f5ff" : "#fff",
                      cursor: "pointer",
                      padding: "10px 8px",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 6
                    }}
                  >
                    <IconComponent size={20} />
                    <Text size="xs" ta="center" lineClamp={2}>
                      {iconName}
                    </Text>
                  </UnstyledButton>
                );
              })}
            </SimpleGrid>
          </ScrollArea>
        </Stack>
      </Modal>
    </div>
  );
}
