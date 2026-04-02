import { useEffect, useState } from "react";
import { Button, Group, Loader, Paper, Stack, Text, Title } from "@mantine/core";
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

  const copyNewsletterContent = async () => {
    if (!data) {
      return;
    }

    setIsCopying(true);
    setCopyMessage(null);

    try {
      const plainText = data.text?.trim() || (() => {
        const parser = document.createElement("div");
        parser.innerHTML = data.html;
        return parser.textContent?.trim() ?? "";
      })();

      if (typeof window.ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        const item = new ClipboardItem({
          "text/html": new Blob([data.html], { type: "text/html" }),
          "text/plain": new Blob([plainText], { type: "text/plain" })
        });
        await navigator.clipboard.write([item]);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(plainText || data.html);
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

  return (
    <Stack gap="md" p="md">
      <Group justify="space-between">
        <Title order={2}>Newsletter Preview</Title>
        <Group gap="xs">
          <Button variant="light" color="blue" onClick={() => void copyNewsletterContent()} loading={isCopying}>
            Copy
          </Button>
          <Button component={Link} to="/newsletters" variant="default">
            Back
          </Button>
        </Group>
      </Group>

      {isLoading ? <Loader /> : null}
      {error ? <Text c="red">{error}</Text> : null}
      {copyMessage ? <Text c="dimmed">{copyMessage}</Text> : null}

      {data ? (
        <>
          <Paper withBorder radius={0} p="md">
            <Stack gap="xs">
              <Text fw={600}>{data.newsletter.title}</Text>
              <Text c="dimmed" size="sm">
                Status: {data.newsletter.status}
              </Text>
              <Text size="sm">Articles: {data.articles.length}</Text>
            </Stack>
          </Paper>

          <Paper withBorder radius={0} p={0}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid #e9ecef" }}>
              <Title order={4}>HTML Preview</Title>
            </div>
            <div style={{ padding: 16 }}>
              <div dangerouslySetInnerHTML={{ __html: data.html }} />
            </div>
          </Paper>
        </>
      ) : null}
    </Stack>
  );
}
