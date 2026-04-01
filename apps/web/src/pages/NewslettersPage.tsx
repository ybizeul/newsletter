import { useEffect, useMemo, useState } from "react";
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Input,
  ScrollArea,
  Select,
  Stack,
  Text,
  TextInput
} from "@mantine/core";
import {
  IconEye,
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
  listArticles,
  listNewsletters,
  scheduleNewsletter,
  sendNewsletterNow,
  updateNewsletter
} from "../lib/api";
import type { Article, Newsletter } from "../types/domain";
import { useNavigate } from "react-router-dom";
import MDEditor from "@uiw/react-md-editor";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";
import "../styles/markdown-editor.css";

const DEMO_CREATOR_ID = "demo-user";

export default function NewslettersPage() {
  const navigate = useNavigate();
  const [articles, setArticles] = useState<Article[]>([]);
  const [newsletters, setNewsletters] = useState<Newsletter[]>([]);
  const [selectedNewsletterId, setSelectedNewsletterID] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [introMarkdown, setIntroMarkdown] = useState("");
  const [articleIds, setArticleIDs] = useState<string[]>([]);
  const [draggedArticleId, setDraggedArticleId] = useState<string | null>(null);
  const [recipientRaw, setRecipientRaw] = useState("first@example.com,second@example.com");
  const [scheduledAtInput, setScheduledAtInput] = useState("");
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
      const [articleItems, newsletterItems] = await Promise.all([listArticles(), listNewsletters()]);
      setArticles(articleItems);
      setNewsletters(newsletterItems);
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
    setArticleIDs([]);
    setDraggedArticleId(null);
    setRecipientRaw("first@example.com,second@example.com");
    setScheduledAtInput("");
  };

  const onSelectNewsletter = (newsletter: Newsletter) => {
    setSelectedNewsletterID(newsletter.id);
    setTitle(newsletter.title);
    setIntroMarkdown(newsletter.introMarkdown);
    setArticleIDs(newsletter.articleIds);
    setRecipientRaw(newsletter.recipientIds.join(","));
    if (newsletter.scheduledAt) {
      setScheduledAtInput(newsletter.scheduledAt.slice(0, 16));
    } else {
      setScheduledAtInput("");
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
                    <Badge variant="light" size="sm" w="fit-content">
                      {newsletter.status}
                    </Badge>
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

      <div style={{ padding: 12, overflow: "auto" }}>
        <Stack>
          <Group justify="space-between">
            <Text fw={700}>{selectedNewsletterId ? "Edit Newsletter" : "New Newsletter"}</Text>
            {selectedNewsletterId ? (
              <Group gap="xs">
                <Button
                  variant="subtle"
                  size="xs"
                  leftSection={<IconEye size={16} />}
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
            
          <TextInput
            label="Recipients (emails, comma-separated)"
            description="Comma-separated recipient addresses used for send and schedule actions."
            placeholder="first@example.com,second@example.com"
            value={recipientRaw}
            onChange={(event) => setRecipientRaw(event.currentTarget.value)}
          />

          <Group grow>
            <TextInput
              type="datetime-local"
              label="Schedule send"
              description="Set when this newsletter should be sent automatically."
              value={scheduledAtInput}
              onChange={(event) => setScheduledAtInput(event.currentTarget.value)}
            />
          </Group>

          <Group justify="space-between">
            <Group gap="xs">
              <Button leftSection={<IconSend size={16} />} onClick={() => void onSave()} loading={isSubmitting}>
                {selectedNewsletterId ? "Save Changes" : "Create Newsletter"}
              </Button>
              <Button variant="light" onClick={() => void onSchedule()} disabled={!selectedNewsletterId}>
                Schedule
              </Button>
              <Button color="green" variant="light" onClick={() => void onSendNow()} disabled={!selectedNewsletterId}>
                Send Now
              </Button>
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
