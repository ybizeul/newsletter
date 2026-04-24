import { Center, Loader, Stack, Text, Title } from "@mantine/core";
import { useEffect } from "react";

export default function LoginPage() {
  useEffect(() => {
    window.location.replace("/api/auth/login");
  }, []);

  return (
    <Center h="100vh">
      <Stack align="center" gap="lg">
        <Title order={2}>Newsletter Workspace</Title>
        <Text c="dimmed" size="sm">Redirecting to corporate login...</Text>
        <Loader size="sm" />
      </Stack>
    </Center>
  );
}
