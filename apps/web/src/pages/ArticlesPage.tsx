import { type ClipboardEvent, useEffect, useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  ScrollArea,
  Stack,
  Text,
  TextInput
} from "@mantine/core";
import { IconFilePlus, IconPencil, IconRefresh, IconTrash } from "@tabler/icons-react";
import MDEditor from "@uiw/react-md-editor";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";
import "../styles/markdown-editor.css";
import { createArticle, deleteArticle, listArticles, updateArticle } from "../lib/api";
import type { Article } from "../types/domain";

const DEMO_AUTHOR_ID = "demo-user";

export default function ArticlesPage() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [selectedArticleId, setSelectedArticleID] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [topicIcon, setTopicIcon] = useState("");
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
  };

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
          illustration: ""
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
          illustration: ""
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

          <TextInput
            label="Title"
            placeholder="Article title"
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />

          <Stack gap={6}>
            <Text size="sm" fw={500}>
              Markdown
            </Text>
            <div data-color-mode="light">
              <MDEditor
                className="markdown-editor-monospace"
                value={markdown}
                onChange={(value) => setMarkdown(value ?? "")}
                preview="live"
                height={350}
                textareaProps={{
                  placeholder: "Write your article in markdown (paste image inline)",
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
          </Stack>

          <TextInput
            label="Topic icon"
            placeholder="Example: sparkles"
            value={topicIcon}
            onChange={(event) => setTopicIcon(event.currentTarget.value)}
          />

          <Group justify="flex-end">
            <Button leftSection={<IconPencil size={16} />} onClick={() => void onSubmit()} loading={isSubmitting}>
              {editingId ? "Save Changes" : "Create Article"}
            </Button>
          </Group>

          {error ? <Text c="red">{error}</Text> : null}
        </Stack>
      </div>
    </div>
  );
}
