import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, Center, Group, Loader, SegmentedControl, Slider, Stack, Text, Title } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { getNewsletterPreview, updateNewsletter } from "../lib/api";
import type { NewsletterPreview } from "../types/domain";

export default function NewsletterPreviewPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const selectedNewsletterId = (location.state as { selectedNewsletterId?: string } | null)?.selectedNewsletterId ?? id;
  const [data, setData] = useState<NewsletterPreview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCopying, setIsCopying] = useState(false);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [previewViewport, setPreviewViewport] = useState<"full" | "mobile">("full");
  const [contentWidth, setContentWidth] = useState(680);
  const widthTimerRef = useRef<number | null>(null);
  const isMobileScreen = useMediaQuery("(max-width: 48em)");

  const refreshPreview = useCallback(async (newsletterId: string) => {
    try {
      const preview = await getNewsletterPreview(newsletterId);
      setData(preview);
    } catch {
      // keep stale preview on transient error
    }
  }, []);

  const onWidthChange = useCallback(
    (value: number) => {
      setContentWidth(value);
      if (!id || !data) return;

      if (widthTimerRef.current !== null) {
        window.clearTimeout(widthTimerRef.current);
      }

      const newsletter = data.newsletter;
      widthTimerRef.current = window.setTimeout(async () => {
        try {
          await updateNewsletter(id, {
            title: newsletter.title,
            headerId: newsletter.headerId ?? "",
            introMarkdown: newsletter.introMarkdown,
            includeIndex: newsletter.includeIndex,
            contentWidth: value,
            articleIds: newsletter.articleIds,
            recipientIds: newsletter.recipientIds
          });
          await refreshPreview(id);
        } catch {
          // silent — width save is best-effort from preview
        }
      }, 400);
    },
    [id, data, refreshPreview]
  );

  const copyNewsletterContent = async () => {
    if (!data) {
      return;
    }

    setIsCopying(true);
    setCopyMessage(null);

    try {
      const parsed = new DOMParser().parseFromString(data.html, "text/html");
      const emailHtml = data.html;

      const plainText =
        data.text?.trim() || parsed.body?.textContent?.trim() || (() => {
          const parser = document.createElement("div");
          parser.innerHTML = emailHtml;
          return parser.textContent?.trim() ?? "";
        })();

      if (typeof window.ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        const item = new ClipboardItem({
          "text/html": new Blob([emailHtml], { type: "text/html" }),
          "text/plain": new Blob([plainText], { type: "text/plain" })
        });
        await navigator.clipboard.write([item]);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(plainText || emailHtml);
      } else {
        throw new Error("Clipboard API is not available in this browser");
      }

      setCopyMessage("Newsletter content copied. You can paste it into your email client.");
    } catch {
      setCopyMessage("Unable to copy automatically in this browser. Please copy from the preview manually.");
    } finally {
      setIsCopying(false);
    }
  };

  useEffect(() => {
    if (!id) {
      setError("Missing newsletter id");
      return;
    }

    const loadPreview = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const preview = await getNewsletterPreview(id);
        setData(preview);
        setContentWidth(preview.newsletter.contentWidth || 680);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load preview");
      } finally {
        setIsLoading(false);
      }
    };

    void loadPreview();
  }, [id]);

  const isMobilePreview = previewViewport === "mobile";

  return (
    <Stack gap="md" p={isMobilePreview ? { base: 4, sm: 4 } : { base: "xs", sm: "md" }}>
      <Group justify="space-between">
        <Title order={2}>Preview</Title>
        <Group gap="xs">
          <Button variant="light" color="blue" onClick={() => void copyNewsletterContent()} loading={isCopying}>
            Copy
          </Button>
          <Button variant="default" onClick={() => navigate("/newsletters", { state: { selectedNewsletterId } })}>
            Close
          </Button>
        </Group>
      </Group>

      {!isMobileScreen ? (
        <Group justify="center" gap="xl">
          <SegmentedControl
            value={previewViewport}
            onChange={(value) => {
              if (value === "full" || value === "mobile") {
                setPreviewViewport(value);
              }
            }}
            data={[
              { label: "Full page", value: "full" },
              { label: "Mobile", value: "mobile" }
            ]}
          />
          {data ? (
            <Group gap="xs" align="center" style={{ minWidth: 260 }}>
              <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                Width: {contentWidth}px
              </Text>
              <Slider
                min={500}
                max={800}
                step={10}
                value={contentWidth}
                onChange={onWidthChange}
                style={{ flex: 1 }}
              />
            </Group>
          ) : null}
        </Group>
      ) : null}

      {isLoading ? (
        <Center h="calc(100vh - 220px)">
          <Loader />
        </Center>
      ) : null}
      {error ? <Text c="red">{error}</Text> : null}
      {copyMessage ? <Text c="dimmed">{copyMessage}</Text> : null}

      {data ? (
        <div style={{ padding: isMobilePreview ? "4px" : undefined }}>
          <Box
            style={
              isMobilePreview
                ? {
                    width: "min(390px, 100%)",
                    margin: "0 auto",
                    border: "1px solid var(--mantine-color-default-border)",
                    borderRadius: 18,
                    overflow: "hidden",
                    background: "var(--mantine-color-gray-1)",
                    boxShadow: "0 10px 24px rgba(0, 0, 0, 0.08)"
                  }
                : undefined
            }
          >
            <div
              style={
                isMobilePreview
                  ? {
                      minHeight: 640,
                      padding: 4,
                      background: "var(--mantine-color-gray-1)"
                    }
                  : undefined
              }
            >
              <div
                style={
                  isMobilePreview
                    ? {
                        minHeight: "100%",
                        background: "var(--mantine-color-body)"
                      }
                    : undefined
                }
              >
                <div dangerouslySetInnerHTML={{ __html: data.html }} />
              </div>
            </div>
          </Box>
        </div>
      ) : null}
    </Stack>
  );
}
