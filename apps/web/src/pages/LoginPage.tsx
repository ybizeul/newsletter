import { Button, Center, Stack, Text, Title } from "@mantine/core";
import { IconLogin } from "@tabler/icons-react";

export default function LoginPage() {
  return (
    <Center h="100vh">
      <Stack align="center" gap="lg">
        <Title order={2}>Newsletter Workspace</Title>
        <Text c="dimmed" size="sm">Sign in to continue</Text>
        <Button
          component="a"
          href="/api/auth/login"
          leftSection={<IconLogin size={18} />}
          size="md"
        >
          Sign in
        </Button>
      </Stack>
    </Center>
  );
}
