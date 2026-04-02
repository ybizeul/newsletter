import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Box,
  Button,
  Checkbox,
  Group,
  Input,
  ScrollArea,
  Select,
  Stack,
  Text,
  TextInput
} from "@mantine/core";
import {
  IconFilePlus,
  IconGripVertical,
  IconRefresh,
  IconSend,
  IconTrash,
  IconX
} from "@tabler/icons-react";
import {
  createNewsletter,
  deleteNewsletter,
  getRuntimeConfig,
  listArticles,
  listNewsletters,
  scheduleNewsletter,
  sendNewsletterNow,
  updateNewsletter
} from "../lib/api";
import type { Article, Newsletter } from "../types/domain";
import { useNavigate } from "react-router-dom";
import { DateTimePicker } from "@mantine/dates";
import MDEditor from "@uiw/react-md-editor";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";
import "../styles/markdown-editor.css";

const DEMO_CREATOR_ID = "demo-user";
const NEWSLETTERS_PANE_WIDTH_STORAGE_KEY = "newsletter.newsletters.pane.width";

function getStoredNewslettersPaneWidth(): number {
  const raw = window.localStorage.getItem(NEWSLETTERS_PANE_WIDTH_STORAGE_KEY);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return 340;
  }
  return Math.min(Math.max(parsed, 260), 900);
}

function formatNewsletterCreatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown date";
  }
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

export default function NewslettersPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [leftPaneWidth, setLeftPaneWidth] = useState(getStoredNewslettersPaneWidth);
  const navigate = useNavigate();
  const [articles, setArticles] = useState<Article[]>([]);
  const [newsletters, setNewsletters] = useState<Newsletter[]>([]);
  const [selectedNewsletterId, setSelectedNewsletterID] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [introMarkdown, setIntroMarkdown] = useState("");
  const [includeIndex, setIncludeIndex] = useState(false);
  const [articleIds, setArticleIDs] = useState<string[]>([]);
  const [draggedArticleId, setDraggedArticleId] = useState<string | null>(null);
  const [recipientRaw, setRecipientRaw] = useState("first@example.com,second@example.com");
  const [scheduledAtInput, setScheduledAtInput] = useState<string | null>(null);
  const [smtpConfigured, setSmtpConfigured] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableArticleOptions = useMemo(
    () => articles.map((article) => ({ value: article.id, label: article.title })),
    [articles]
  );

  const selectedArticleRows = useMemo(
    () =>
      articleIds.map((articleId) => {
        const article = articles.find((item) => item.id === articleId);
        return {
          id: articleId,
          title: article?.title ?? "(missing article)",
          illustration: article?.illustration ?? "",
          exists: Boolean(article)
        };
      }),
    [articleIds, articles]
  );

  const articleOptionsForAdd = useMemo(
    () => availableArticleOptions.filter((option) => !articleIds.includes(option.value)),
    [availableArticleOptions, articleIds]
  );

  const loadData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [articleItems, newsletterItems, runtimeConfig] = await Promise.all([
        listArticles(),
        listNewsletters(),
        getRuntimeConfig()
      ]);
      setArticles(articleItems);
      setNewsletters(newsletterItems);
      setSmtpConfigured(runtimeConfig.smtpConfigured);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load newsletters");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const resetForm = () => {
    setSelectedNewsletterID(null);
    setTitle("");
    setIntroMarkdown("");
    setIncludeIndex(false);
    setArticleIDs([]);
    setDraggedArticleId(null);
    setRecipientRaw("first@example.com,second@example.com");
    setScheduledAtInput(null);
  };

  const onSelectNewsletter = (newsletter: Newsletter) => {
    setSelectedNewsletterID(newsletter.id);
    setTitle(newsletter.title);
    setIntroMarkdown(newsletter.introMarkdown);
    setIncludeIndex(Boolean(newsletter.includeIndex));
    setArticleIDs(newsletter.articleIds);
    setRecipientRaw(newsletter.recipientIds.join(","));
    if (newsletter.scheduledAt) {
      setScheduledAtInput(newsletter.scheduledAt);
    } else {
      setScheduledAtInput(null);
    }
  };

  useEffect(() => {
    if (newsletters.length === 0) {
      return;
    }

    if (!selectedNewsletterId) {
      onSelectNewsletter(newsletters[0]);
      return;
    }

    if (!newsletters.some((newsletter) => newsletter.id === selectedNewsletterId)) {
      resetForm();
    }
  }, [newsletters]);

  const parseRecipients = () =>
    recipientRaw
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

  const onSave = async () => {
    if (!title.trim()) {
      setError("Title is required");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      if (selectedNewsletterId) {
        const updated = await updateNewsletter(selectedNewsletterId, {
          title: title.trim(),
          introMarkdown: introMarkdown.trim(),
          includeIndex,
          articleIds,
          recipientIds: parseRecipients()
        });
        setNewsletters((current) =>
          current.map((newsletter) => (newsletter.id === selectedNewsletterId ? updated : newsletter))
        );
      } else {
        const created = await createNewsletter({
          creatorId: DEMO_CREATOR_ID,
          title: title.trim(),
          introMarkdown: introMarkdown.trim(),
          includeIndex,
          articleIds,
          recipientIds: parseRecipients()
        });
        setNewsletters((current) => [created, ...current]);
        setSelectedNewsletterID(created.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save newsletter");
    } finally {
      setIsSubmitting(false);
    }
  };

  const onSchedule = async () => {
    if (!selectedNewsletterId) {
      setError("Select a newsletter first");
      return;
    }
    if (!scheduledAtInput) {
      setError("Select schedule date and time first");
      return;
    }

    setError(null);
    try {
      await scheduleNewsletter(selectedNewsletterId, new Date(scheduledAtInput).toISOString());
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to schedule newsletter");
    }
  };

  const onSendNow = async () => {
    if (!selectedNewsletterId) {
      setError("Select a newsletter first");
      return;
    }

    setError(null);
    try {
      await sendNewsletterNow(selectedNewsletterId);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send newsletter now");
    }
  };

  const onDelete = async (newsletterId: string) => {
    const ok = window.confirm("Delete this newsletter?");
    if (!ok) {
      return;
    }

    setError(null);
    try {
      await deleteNewsletter(newsletterId);
      setNewsletters((current) => current.filter((newsletter) => newsletter.id !== newsletterId));
      if (selectedNewsletterId === newsletterId) {
        resetForm();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete newsletter");
    }
  };

  const removeArticleFromNewsletter = (articleId: string) => {
    setArticleIDs((current) => current.filter((id) => id !== articleId));
  };

  const moveArticle = (sourceId: string, targetId: string) => {
    if (sourceId === targetId) {
      return;
    }

    setArticleIDs((current) => {
      const sourceIndex = current.indexOf(sourceId);
      const targetIndex = current.indexOf(targetId);
      if (sourceIndex < 0 || targetIndex < 0) {
        return current;
      }

      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  };

  const selectedNewsletter = newsletters.find((newsletter) => newsletter.id === selectedNewsletterId) ?? null;

  const startPaneResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const containerRect = containerRef.current?.getBoundingClientRect();
    const containerLeft = containerRect?.left ?? 0;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const containerWidth = containerRef.current?.getBoundingClientRect().width ?? 1200;
      const minWidth = 260;
      const maxWidth = Math.max(minWidth, containerWidth - 420);
      const nextWidth = moveEvent.clientX - containerLeft;
      const clampedWidth = Math.min(Math.max(nextWidth, minWidth), maxWidth);
      setLeftPaneWidth(clampedWidth);
      window.localStorage.setItem(NEWSLETTERS_PANE_WIDTH_STORAGE_KEY, String(clampedWidth));
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  return (
    <div
      ref={containerRef}
      style={{
        display: "grid",
        gridTemplateColumns: `${leftPaneWidth}px 1fr`,
        gap: 0,
        height: "calc(100vh - 120px)",
        minHeight: 560,
        position: "relative"
      }}
    >
      <div style={{ overflow: "hidden" }}>
        <Group justify="space-between" p="sm" style={{ borderBottom: "1px solid #e9ecef" }}>
          <Text fw={600}>Newsletters ({newsletters.length})</Text>
          <Group gap="xs">
            <ActionIcon variant="light" onClick={resetForm} title="New newsletter">
              <IconFilePlus size={16} />
            </ActionIcon>
            <ActionIcon variant="light" onClick={() => void loadData()} loading={isLoading} title="Refresh">
              <IconRefresh size={16} />
            </ActionIcon>
          </Group>
        </Group>

        <ScrollArea h="calc(100% - 52px)" offsetScrollbars>
          <Stack gap={0}>
            {newsletters.map((newsletter) => (
              <div
                key={newsletter.id}
                onClick={() => onSelectNewsletter(newsletter)}
                style={{
                  padding: 12,
                  borderBottom: "1px solid #f1f3f5",
                  cursor: "pointer",
                  backgroundColor: selectedNewsletterId === newsletter.id ? "#f1fbff" : "transparent"
                }}
              >
                <Group justify="space-between" align="flex-start">
                  <Stack gap={4} style={{ flex: 1 }}>
                    <Text fw={600} lineClamp={1}>
                      {newsletter.title}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {formatNewsletterCreatedAt(newsletter.createdAt)}
                    </Text>
                  </Stack>
                  <ActionIcon
                    color="red"
                    variant="subtle"
                    onClick={(event) => {
                      event.stopPropagation();
                      void onDelete(newsletter.id);
                    }}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              </div>
            ))}
            {newsletters.length === 0 ? (
              <Text c="dimmed" size="sm" p="md">
                No newsletters yet.
              </Text>
            ) : null}
          </Stack>
        </ScrollArea>
      </div>

      <div
        onMouseDown={startPaneResize}
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: leftPaneWidth - 4,
          width: 8,
          cursor: "col-resize",
          zIndex: 20,
          background: "linear-gradient(to right, transparent 3px, #e9ecef 3px, #e9ecef 4px, transparent 4px)"
        }}
      />

      <div style={{ padding: 12, overflow: "auto" }}>
        <Stack>
          <Group justify="space-between">
            <Text fw={700}>{selectedNewsletterId ? "Edit Newsletter" : "New Newsletter"}</Text>
            {selectedNewsletterId ? (
              <Group gap="xs">
                <Button
                  variant="light"
                  color="blue"
                  size="xs"
                  onClick={() => navigate(`/newsletters/${selectedNewsletterId}/preview`)}
                >
                  Preview
                </Button>
                <Button variant="default" size="xs" onClick={resetForm}>
                  Cancel
                </Button>
                <Button color="red" variant="light" size="xs" onClick={() => void onDelete(selectedNewsletterId)}>
                  Delete
                </Button>
              </Group>
            ) : null}
          </Group>

          <TextInput
            label="Title"
            description="Display title for this newsletter edition."
            placeholder="April Product Digest"
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />

          <Input.Wrapper
            label="Introduction (Markdown)"
            description="Write the opening section shown before the selected articles."
          >
            <div data-color-mode="light">
              <MDEditor
                className="markdown-editor-monospace"
                value={introMarkdown}
                onChange={(value) => setIntroMarkdown(value ?? "")}
                preview="live"
                height={350}
                textareaProps={{
                  placeholder: "Welcome to this edition...",
                  style: {
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace",
                    fontSize: 14,
                    lineHeight: 1.6
                  }
                }}
              />
            </div>
          </Input.Wrapper>

          <Checkbox
            label="Index"
            description="Generate an index of the articles after the introduction"
            checked={includeIndex}
            onChange={(event) => setIncludeIndex(event.currentTarget.checked)}
          />

            <Stack gap="xs">

            <Group align="end" grow>
              <Select
                label="Add existing article"
                description="Choose an article from the library to append to this newsletter."
                placeholder="Choose an article"
                data={articleOptionsForAdd}
                value={null}
                onChange={(value) => {
                  if (!value || articleIds.includes(value)) {
                    return;
                  }
                  setArticleIDs((current) => [...current, value]);
                }}
                searchable
                nothingFoundMessage="No more articles available"
              />
            </Group>

            <Stack gap={8}>
              {selectedArticleRows.map((article) => (
                <div
                  key={article.id}
                  draggable
                  onDragStart={() => setDraggedArticleId(article.id)}
                  onDragEnd={() => setDraggedArticleId(null)}
                  onDragOver={(event) => event.preventDefault()}
                  onDragEnter={() => {
                    if (draggedArticleId) {
                      moveArticle(draggedArticleId, article.id);
                    }
                  }}
                  style={{
                    width: "100%",
                    border: "1px solid #e9ecef",
                    borderRadius: 8,
                    padding: "8px 10px",
                    background: "#fff",
                    cursor: "grab"
                  }}
                >
                  <Group justify="space-between" wrap="nowrap" style={{ width: "100%" }}>
                    <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center"
                        }}
                        title="Drag row to reorder"
                      >
                        <IconGripVertical size={16} color="#868e96" />
                      </div>
                      <Box
                        style={{
                          width: 26,
                          height: 26,
                          borderRadius: 9999,
                          border: "1px solid #dee2e6",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          overflow: "hidden",
                          background: "#f8f9fa",
                          flexShrink: 0
                        }}
                      >
                        {article.illustration ? (
                          <Box
                            component="img"
                            src={article.illustration}
                            alt="Article icon"
                            w={26}
                            h={26}
                            style={{ display: "block" }}
                          />
                        ) : (
                          <Text size="xs" c="dimmed">
                            -
                          </Text>
                        )}
                      </Box>
                      <Text size="sm" c={article.exists ? undefined : "dimmed"} truncate="end">
                        {article.title}
                      </Text>
                    </Group>
                    <ActionIcon
                      color="red"
                      variant="subtle"
                      onClick={() => removeArticleFromNewsletter(article.id)}
                      title="Remove"
                    >
                      <IconX size={16} />
                    </ActionIcon>
                  </Group>
                </div>
              ))}

              {selectedArticleRows.length === 0 ? (
                <Text size="sm" c="dimmed">
                  No articles selected.
                </Text>
              ) : null}
            </Stack>
            </Stack>
            
          {smtpConfigured ? (
            <TextInput
              label="Recipients (emails, comma-separated)"
              description="Comma-separated recipient addresses used for send and schedule actions."
              placeholder="first@example.com,second@example.com"
              value={recipientRaw}
              onChange={(event) => setRecipientRaw(event.currentTarget.value)}
            />
          ) : null}

          {smtpConfigured ? (
            <Group grow>
              <DateTimePicker
                label="Schedule send"
                description="Set when this newsletter should be sent automatically."
                value={scheduledAtInput}
                onChange={setScheduledAtInput}
                clearable
              />
            </Group>
          ) : null}

          <Group justify="space-between">
            <Group gap="xs">
              <Button onClick={() => void onSave()} loading={isSubmitting}>
                {selectedNewsletterId ? "Save Changes" : "Create Newsletter"}
              </Button>
              {smtpConfigured ? (
                <Button variant="light" onClick={() => void onSchedule()} disabled={!selectedNewsletterId}>
                  Schedule
                </Button>
              ) : null}
              {smtpConfigured ? (
                <Button
                  color="green"
                  variant="light"
                  leftSection={<IconSend size={16} />}
                  onClick={() => void onSendNow()}
                  disabled={!selectedNewsletterId}
                >
                  Send Now
                </Button>
              ) : null}
            </Group>
          </Group>

          {selectedNewsletter?.deliveryError ? (
            <Text c="red" size="sm">
              Last Error: {selectedNewsletter.deliveryError}
            </Text>
          ) : null}

          {error ? <Text c="red">{error}</Text> : null}
        </Stack>
      </div>
    </div>
  );
}
