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
        <Button component={Link} to="/newsletters" variant="default">
          Back
        </Button>
      </Group>

      {isLoading ? <Loader /> : null}
      {error ? <Text c="red">{error}</Text> : null}

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
