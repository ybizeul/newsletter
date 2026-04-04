import { useEffect, useState } from "react";
import { Box, Button, Group, Loader, SegmentedControl, Stack, Text, Title } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { Link, useParams } from "react-router-dom";
import { getNewsletterPreview } from "../lib/api";
import type { NewsletterPreview } from "../types/domain";

export default function NewsletterPreviewPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<NewsletterPreview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCopying, setIsCopying] = useState(false);
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [previewViewport, setPreviewViewport] = useState<"full" | "mobile">("full");
  const isMobileScreen = useMediaQuery("(max-width: 48em)");

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
          <Button component={Link} to="/newsletters" variant="default">
            Close
          </Button>
        </Group>
      </Group>

      {!isMobileScreen ? (
        <Group justify="center">
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
        </Group>
      ) : null}

      {isLoading ? <Loader /> : null}
      {error ? <Text c="red">{error}</Text> : null}
      {copyMessage ? <Text c="dimmed">{copyMessage}</Text> : null}

      {data ? (
        <div style={{ padding: isMobilePreview ? "4px" : "clamp(10px, 3vw, 16px)" }}>
          <Box
            style={
              isMobilePreview
                ? {
                    width: "min(390px, 100%)",
                    margin: "0 auto",
                    border: "1px solid #dee2e6",
                    borderRadius: 18,
                    overflow: "hidden",
                    background: "#f1f3f5",
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
                      background: "#f1f3f5"
                    }
                  : undefined
              }
            >
              <div
                style={
                  isMobilePreview
                    ? {
                        minHeight: "100%",
                        background: "#ffffff"
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
