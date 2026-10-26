import { useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Button,
  Center,
  Code,
  CopyButton,
  Group,
  Loader,
  Modal,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Title
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconAlertTriangle, IconTrash } from "@tabler/icons-react";
import { Navigate } from "react-router-dom";
import { createMCPToken, listMCPTokens, revokeMCPToken } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { MCPToken } from "../types/domain";

const MAX_LABEL_LENGTH = 100;
const TOKEN_PLACEHOLDER = "<token>";

type IssuedToken = {
  id: string;
  label: string;
  token: string;
};

function mcpEndpoint(): string {
  return `${window.location.origin}/mcp`;
}

function claudeCodeCommand(token: string): string {
  return `claude mcp add --transport http newsletter ${mcpEndpoint()} --header "Authorization: Bearer ${token}"`;
}

function formatTimestamp(value: string | undefined, emptyLabel: string): string {
  if (!value) {
    return emptyLabel;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown date";
  }
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function withoutSecret(token: MCPToken): MCPToken {
  return {
    id: token.id,
    label: token.label,
    tokenHint: token.tokenHint,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt
  };
}

function CopyAction({ value, label }: { value: string; label: string }) {
  return (
    <CopyButton value={value} timeout={2000}>
      {({ copied, copy }) => (
        <Button variant="light" onClick={copy}>
          {copied ? "Copied" : label}
        </Button>
      )}
    </CopyButton>
  );
}

function RevokeTokenButton({ token, onRevoke }: { token: MCPToken; onRevoke: (token: MCPToken) => void }) {
  return (
    <ActionIcon
      variant="subtle"
      color="red"
      aria-label={`Revoke ${token.label}`}
      title="Revoke"
      onClick={() => onRevoke(token)}
    >
      <IconTrash size={16} />
    </ActionIcon>
  );
}

export default function McpAccessPage() {
  const { oidcEnabled } = useAuth();
  const isMobile = useMediaQuery("(max-width: 48em)");
  const listRequest = useRef(0);
  const issuedRef = useRef<HTMLDivElement | null>(null);
  const revokeLabelRef = useRef("this token");

  const [tokens, setTokens] = useState<MCPToken[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<MCPToken | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  const loadTokens = async () => {
    const requestId = ++listRequest.current;
    setIsLoading(true);
    setLoadError(null);
    try {
      const items = await listMCPTokens();
      if (requestId !== listRequest.current) {
        return;
      }
      setTokens(items.map(withoutSecret));
    } catch (err) {
      if (requestId !== listRequest.current) {
        return;
      }
      setLoadError(err instanceof Error ? err.message : "Failed to load tokens");
    } finally {
      if (requestId === listRequest.current) {
        setIsLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!oidcEnabled) {
      return;
    }
    void loadTokens();
  }, [oidcEnabled]);

  useEffect(() => {
    issuedRef.current?.scrollIntoView({ block: "nearest" });
  }, [issued?.id]);

  const onCreate = async () => {
    const nextLabel = label.trim();
    if (!nextLabel) {
      setActionError("Label is required");
      return;
    }
    if ([...nextLabel].length > MAX_LABEL_LENGTH) {
      setActionError("Label must be at most 100 characters");
      return;
    }

    setIsCreating(true);
    setActionError(null);
    try {
      const created = await createMCPToken(nextLabel);
      if (!created.token) {
        setActionError("The server did not return a token secret");
        return;
      }
      listRequest.current += 1;
      setIsLoading(false);
      setIssued({ id: created.id, label: created.label, token: created.token });
      setTokens((current) => [withoutSecret(created), ...current.filter((token) => token.id !== created.id)]);
      setLabel("");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to create token");
    } finally {
      setIsCreating(false);
    }
  };

  const confirmRevoke = async () => {
    if (!revokeTarget) {
      return;
    }
    setIsRevoking(true);
    setActionError(null);
    try {
      await revokeMCPToken(revokeTarget.id);
      setTokens((current) => current.filter((token) => token.id !== revokeTarget.id));
      setIssued((current) => (current?.id === revokeTarget.id ? null : current));
      setRevokeTarget(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to revoke token");
    } finally {
      setIsRevoking(false);
    }
  };

  if (revokeTarget) {
    revokeLabelRef.current = revokeTarget.label;
  }

  if (!oidcEnabled) {
    return <Navigate to="/articles" replace />;
  }

  const commandToken = issued?.token ?? TOKEN_PLACEHOLDER;
  const command = claudeCodeCommand(commandToken);

  return (
    <Stack gap="lg" p="md" maw={840}>
      <Stack gap={4}>
        <Title order={2}>MCP access</Title>
        <Text size="sm" c="dimmed">
          Personal access tokens let Claude Code, Cursor, and Claude Desktop search articles you can see and create private drafts as you. A token cannot send newsletters, change contacts, or delete content. The secret is shown once, when you create the token.
        </Text>
      </Stack>

      <Paper withBorder p="md">
        <Stack gap="sm">
          <Text fw={600}>Create a token</Text>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void onCreate();
            }}
          >
            <Stack gap="sm">
              {actionError && !revokeTarget ? (
                <Text c="red" size="sm" role="alert">{actionError}</Text>
              ) : null}
              <Group align="flex-end" wrap="wrap">
                <TextInput
                  label="Label"
                  description="A name you will recognize later, such as Claude Code on your laptop."
                  placeholder="Claude Code"
                  value={label}
                  maxLength={MAX_LABEL_LENGTH}
                  onChange={(event) => setLabel(event.currentTarget.value)}
                  style={{ flex: "1 1 240px" }}
                  required
                />
                <Button type="submit" loading={isCreating} disabled={!label.trim()}>
                  Create token
                </Button>
              </Group>
            </Stack>
          </form>
        </Stack>
      </Paper>

      {issued ? (
        <Paper withBorder p="md" ref={issuedRef}>
          <Stack gap="md">
            <Alert
              color="yellow"
              variant="light"
              icon={<IconAlertTriangle size={18} />}
              title="Copy this token now"
            >
              This secret for {issued.label} is shown only once. Dismissing it, leaving this page, or creating another token hides it for good.
            </Alert>
            <Group align="flex-end" wrap="wrap" gap="sm">
              <TextInput
                label="Personal access token"
                value={issued.token}
                readOnly
                spellCheck={false}
                style={{ flex: 1 }}
                styles={{ input: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" } }}
              />
              <CopyAction value={issued.token} label="Copy token" />
            </Group>
          </Stack>
        </Paper>
      ) : null}

      <Paper withBorder p="md">
        <Stack gap="sm">
          <Text fw={600}>Connect Claude Code</Text>
          <Text size="sm" c="dimmed">
            {issued
              ? "This command includes the token you just created. Copy it before you dismiss the secret. Cursor and Claude Desktop can use the same endpoint with an Authorization: Bearer header."
              : "Run this command after you create a token, and replace the token placeholder with that secret. Cursor and Claude Desktop can use the same endpoint with an Authorization: Bearer header."}
          </Text>
          <Text size="sm">
            Endpoint <Code>{mcpEndpoint()}</Code>
          </Text>
          <Code block style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {command}
          </Code>
          <Group justify="space-between" align="center" wrap="wrap">
            <CopyAction value={command} label="Copy command" />
            {issued ? (
              <Button variant="default" onClick={() => setIssued(null)}>
                I&apos;ve saved this token
              </Button>
            ) : null}
          </Group>
        </Stack>
      </Paper>

      <Stack gap="sm">
        <Text fw={600}>Your tokens</Text>
        {loadError ? (
          <Group gap="sm">
            <Text c="red" size="sm" role="alert">{loadError}</Text>
            <Button variant="subtle" size="compact-sm" onClick={() => void loadTokens()}>
              Retry
            </Button>
          </Group>
        ) : null}
        {isLoading && tokens.length === 0 ? (
          <Center py="xl">
            <Loader size="sm" />
          </Center>
        ) : tokens.length === 0 ? (
          <Text c="dimmed" size="sm">No tokens yet. Create one to connect a client.</Text>
        ) : isMobile ? (
          <Stack gap="sm">
            {tokens.map((token) => (
              <Paper key={token.id} withBorder p="sm">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Stack gap={4} style={{ minWidth: 0 }}>
                    <Text fw={600} style={{ overflowWrap: "anywhere" }}>{token.label}</Text>
                    <Text size="sm">Prefix <Code>{token.tokenHint}</Code></Text>
                    <Text size="xs" c="dimmed">Created {formatTimestamp(token.createdAt, "Unknown date")}</Text>
                    <Text size="xs" c="dimmed">Last used {formatTimestamp(token.lastUsedAt, "Never")}</Text>
                  </Stack>
                  <RevokeTokenButton
                    token={token}
                    onRevoke={(next) => {
                      setActionError(null);
                      setRevokeTarget(next);
                    }}
                  />
                </Group>
              </Paper>
            ))}
          </Stack>
        ) : (
          <Table.ScrollContainer minWidth={640}>
            <Table verticalSpacing="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Label</Table.Th>
                  <Table.Th>Prefix</Table.Th>
                  <Table.Th>Created</Table.Th>
                  <Table.Th>Last used</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {tokens.map((token) => (
                  <Table.Tr key={token.id}>
                    <Table.Td>{token.label}</Table.Td>
                    <Table.Td>
                      <Code>{token.tokenHint}</Code>
                    </Table.Td>
                    <Table.Td style={{ whiteSpace: "nowrap" }}>{formatTimestamp(token.createdAt, "Unknown date")}</Table.Td>
                    <Table.Td style={{ whiteSpace: "nowrap" }}>{formatTimestamp(token.lastUsedAt, "Never")}</Table.Td>
                    <Table.Td style={{ width: 1 }}>
                      <RevokeTokenButton
                        token={token}
                        onRevoke={(next) => {
                          setActionError(null);
                          setRevokeTarget(next);
                        }}
                      />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Stack>

      <Modal
        opened={revokeTarget !== null}
        onClose={() => {
          if (!isRevoking) {
            setRevokeTarget(null);
            setActionError(null);
          }
        }}
        title="Revoke token"
        centered
      >
        <Stack>
          <Text size="sm">
            Revoke {revokeLabelRef.current}? Clients using it lose access immediately.
          </Text>
          {actionError ? (
            <Text c="red" size="sm" role="alert">{actionError}</Text>
          ) : null}
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => {
                setRevokeTarget(null);
                setActionError(null);
              }}
              disabled={isRevoking}
            >
              Cancel
            </Button>
            <Button color="red" loading={isRevoking} onClick={() => void confirmRevoke()}>
              Revoke
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
