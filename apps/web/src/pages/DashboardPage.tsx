import { Card, Group, Stack, Text, Title } from "@mantine/core";
import { useNavigate } from "react-router-dom";

export default function DashboardPage() {
  const navigate = useNavigate();

  return (
    <Stack gap="md" p="md">
      <Title order={2}>Dashboard</Title>
      <Text c="dimmed">Kickoff workspace for collaborative newsletter creation.</Text>
      <Group grow>
        <Card
          withBorder
          radius={0}
          padding="lg"
          style={{ cursor: "pointer" }}
          onClick={() => navigate("/articles")}
        >
          <Text fw={600}>Article Workflow</Text>
          <Text size="sm" c="dimmed">
            Draft and publish markdown articles with optional image and topic icon.
          </Text>
        </Card>
        <Card
          withBorder
          radius={0}
          padding="lg"
          style={{ cursor: "pointer" }}
          onClick={() => navigate("/newsletters")}
        >
          <Text fw={600}>Newsletter Composer</Text>
          <Text size="sm" c="dimmed">
            Pick articles, write intro text, and schedule HTML emails.
          </Text>
        </Card>
      </Group>
    </Stack>
  );
}
