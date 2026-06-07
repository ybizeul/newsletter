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
            language: newsletter.language,
            template: newsletter.template,
            headerId: newsletter.headerId ?? "",
            introMarkdown: newsletter.introMarkdown,
            introHTML: newsletter.introHTML,
            footerMarkdown: newsletter.footerMarkdown,
            footerHTML: newsletter.footerHTML,
            includeIndex: newsletter.includeIndex,
            contentWidth: value,
            archived: newsletter.archived,
            articleIds: newsletter.articleIds,
            recipientIds: newsletter.recipientIds,
            contactTags: newsletter.contactTags,
            contactTagsMode: newsletter.contactTagsMode
          });
          await refreshPreview(id);
        } catch {
          // silent — width save is best-effort from preview
        }
      }, 400);
    },
    [id, data, refreshPreview]
  );

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
                <div className="newsletter-preview" dangerouslySetInnerHTML={{ __html: data.html }} />
              </div>
            </div>
          </Box>
        </div>
      ) : null}

      <style>{`
        [data-mantine-color-scheme="dark"] .newsletter-preview body,
        [data-mantine-color-scheme="dark"] .newsletter-preview {
          color: var(--mantine-color-text) !important;
        }
        [data-mantine-color-scheme="dark"] .newsletter-preview td,
        [data-mantine-color-scheme="dark"] .newsletter-preview p,
        [data-mantine-color-scheme="dark"] .newsletter-preview b,
        [data-mantine-color-scheme="dark"] .newsletter-preview span {
          color: inherit !important;
        }
        [data-mantine-color-scheme="dark"] .newsletter-preview blockquote {
          background-color: var(--mantine-color-dark-6) !important;
          border-left-color: var(--mantine-color-dark-4) !important;
        }
        [data-mantine-color-scheme="dark"] .newsletter-preview table[style*="background:#f1f3f5"] {
          background: var(--mantine-color-dark-6) !important;
          border-color: var(--mantine-color-dark-4) !important;
        }
        [data-mantine-color-scheme="dark"] .newsletter-preview td[style*="border-top:1px solid #e5e7eb"] {
          border-top-color: var(--mantine-color-dark-4) !important;
        }
      `}</style>
    </Stack>
  );
}
