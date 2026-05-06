import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Stack,
  TagsInput,
  Text,
  Textarea,
  TextInput
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconPlus, IconUserPlus, IconX } from "@tabler/icons-react";
import { bulkImportContacts, createContact, deleteContact, listContacts, updateContact } from "../lib/api";
import type { Contact } from "../types/domain";

const CONTACTS_PANE_WIDTH_STORAGE_KEY = "newsletter.contacts.pane.width";

function getStoredPaneWidth(): number {
  const raw = window.localStorage.getItem(CONTACTS_PANE_WIDTH_STORAGE_KEY);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 340;
  return Math.min(Math.max(parsed, 220), 700);
}

function contactDisplayName(contact: Contact): string {
  const full = [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim();
  return full || contact.email;
}

type FormState = {
  firstName: string;
  lastName: string;
  email: string;
  tags: string[];
};

const emptyForm: FormState = { firstName: "", lastName: "", email: "", tags: [] };

export default function ContactsPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isMobile = useMediaQuery("(max-width: 48em)");
  const [leftPaneWidth, setLeftPaneWidth] = useState(getStoredPaneWidth);
  const [isMobileEditorOpen, setIsMobileEditorOpen] = useState(false);

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [isNewMode, setIsNewMode] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deleteContactId, setDeleteContactId] = useState<string | null>(null);

  // Bulk import state
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number } | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const c of contacts) {
      for (const t of c.tags ?? []) {
        set.add(t);
      }
    }
    return Array.from(set).sort();
  }, [contacts]);

  const loadContacts = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const items = await listContacts();
      setContacts(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load contacts");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadContacts();
  }, []);

  useEffect(() => {
    if (!isMobile) {
      setIsMobileEditorOpen(false);
    }
  }, [isMobile]);

  const openNew = () => {
    setSelectedContactId(null);
    setIsNewMode(true);
    setForm(emptyForm);
    setImportText("");
    setImportError(null);
    setImportResult(null);
    setError(null);
    if (isMobile) setIsMobileEditorOpen(true);
  };

  const openEdit = (contact: Contact) => {
    setIsNewMode(false);
    setSelectedContactId(contact.id);
    setForm({
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      tags: contact.tags ?? []
    });
    setError(null);
    if (isMobile) setIsMobileEditorOpen(true);
  };

  const onSave = async () => {
    if (!form.email.trim()) {
      setError("Email is required");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      if (isNewMode) {
        const created = await createContact({
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          email: form.email.trim(),
          tags: form.tags
        });
        setContacts((prev) => [created, ...prev].sort(sortContacts));
        setSelectedContactId(created.id);
        setIsNewMode(false);
      } else if (selectedContactId) {
        const updated = await updateContact(selectedContactId, {
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          email: form.email.trim(),
          tags: form.tags
        });
        setContacts((prev) => prev.map((c) => (c.id === selectedContactId ? updated : c)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save contact");
    } finally {
      setIsSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteContactId) return;
    try {
      await deleteContact(deleteContactId);
      setContacts((prev) => prev.filter((c) => c.id !== deleteContactId));
      if (selectedContactId === deleteContactId) {
        setSelectedContactId(null);
        setIsNewMode(false);
        setForm(emptyForm);
        if (isMobile) setIsMobileEditorOpen(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete contact");
    } finally {
      setDeleteContactId(null);
    }
  };

  const parseImportText = (raw: string): Array<{ firstName: string; lastName: string; email: string; tags: string[] }> => {
    return raw
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const cols = line.split("\t");
        const firstName = (cols[0] ?? "").trim();
        const lastName = (cols[1] ?? "").trim();
        const email = (cols[2] ?? "").trim();
        const rawTags = (cols[3] ?? "").trim();
        const tags = rawTags
          ? rawTags.split(",").map((t) => t.trim()).filter(Boolean)
          : [];
        return { firstName, lastName, email, tags };
      });
  };

  const onImport = async () => {
    setImportError(null);
    setImportResult(null);
    const parsed = parseImportText(importText);
    if (parsed.length === 0) {
      setImportError("No valid rows found. Expected tab-separated: First Name, Last Name, Email, Tags (comma-separated).");
      return;
    }
    setIsImporting(true);
    try {
      const result = await bulkImportContacts(parsed);
      setImportResult(result);
      setImportText("");
      await loadContacts();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setIsImporting(false);
    }
  };

  const startPaneResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const containerRect = containerRef.current?.getBoundingClientRect();
    const containerLeft = containerRect?.left ?? 0;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const containerWidth = containerRef.current?.getBoundingClientRect().width ?? 1200;
      const minWidth = 220;
      const maxWidth = Math.max(minWidth, containerWidth - 420);
      const nextWidth = Math.min(Math.max(moveEvent.clientX - containerLeft, minWidth), maxWidth);
      setLeftPaneWidth(nextWidth);
      window.localStorage.setItem(CONTACTS_PANE_WIDTH_STORAGE_KEY, String(nextWidth));
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const isEditing = !isNewMode && selectedContactId !== null;
  const rightPanelTitle = isNewMode ? "New Contact" : isEditing ? "Edit Contact" : "Select a contact";

  return (
    <div
      ref={containerRef}
      style={{
        display: "grid",
        gridTemplateColumns: isMobile ? "1fr" : `${leftPaneWidth}px 1fr`,
        gap: 0,
        height: "calc(100vh - 60px)",
        minHeight: 560,
        position: "relative"
      }}
    >
        <div style={{ overflow: "hidden", display: isMobile && isMobileEditorOpen ? "none" : undefined }}>
          <Group justify="space-between" p="sm" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
            <Text fw={600}>Contacts ({contacts.length})</Text>
            <Button
              variant="light"
              size="xs"
              leftSection={<IconUserPlus size={14} />}
              onClick={openNew}
            >
              New
            </Button>
          </Group>

          <ScrollArea h="calc(100% - 52px)" offsetScrollbars>
            <Stack gap={0}>
              {isLoading && contacts.length === 0 ? (
                <Group justify="center" p="md" gap="xs">
                  <Loader size="sm" />
                  <Text c="dimmed" size="sm">Loading contacts...</Text>
                </Group>
              ) : contacts.length === 0 ? (
                <Text c="dimmed" size="sm" p="md">No contacts yet.</Text>
              ) : (
                contacts.map((contact) => (
                  <div
                    key={contact.id}
                    onClick={() => openEdit(contact)}
                    style={{
                      padding: "10px 12px",
                      borderBottom: "1px solid var(--mantine-color-default-border)",
                      cursor: "pointer",
                      backgroundColor: selectedContactId === contact.id ? "var(--mantine-primary-color-light)" : "transparent"
                    }}
                  >
                    <Group justify="space-between" wrap="nowrap">
                      <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                        <Text size="sm" fw={500} truncate>
                          {contactDisplayName(contact)}
                        </Text>
                        <Text size="xs" c="dimmed" truncate>
                          {contact.email}
                        </Text>
                        {contact.tags && contact.tags.length > 0 ? (
                          <Group gap={4} wrap="wrap">
                            {contact.tags.map((tag) => (
                              <Badge key={tag} size="xs" variant="light" color="blue">
                                {tag}
                              </Badge>
                            ))}
                          </Group>
                        ) : null}
                      </Stack>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        size="sm"
                        title="Delete contact"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteContactId(contact.id);
                        }}
                      >
                        <IconX size={14} />
                      </ActionIcon>
                    </Group>
                  </div>
                ))
              )}
            </Stack>
          </ScrollArea>
        </div>

      {!isMobile ? (
        <div
          onMouseDown={startPaneResize}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: leftPaneWidth - 4,
            width: 8,
            cursor: "col-resize",
            zIndex: 20,
            background:
              "linear-gradient(to right, transparent 3px, var(--mantine-color-default-border) 3px, var(--mantine-color-default-border) 4px, transparent 4px)"
          }}
        />
      ) : null}

        <div style={{ padding: "12px clamp(8px, 2.5vw, 12px)", overflow: "auto", display: isMobile && !isMobileEditorOpen ? "none" : undefined }}>
          <Stack>
            <Group justify="space-between">
              <Group gap="xs">
                {isMobile ? (
                  <Button variant="subtle" size="xs" onClick={() => setIsMobileEditorOpen(false)}>
                    Back
                  </Button>
                ) : null}
                {isMobile && isEditing ? (
                  <ActionIcon
                    variant="light"
                    size="md"
                    aria-label="New Contact"
                    title="New Contact"
                    onClick={openNew}
                  >
                    <IconPlus size={16} />
                  </ActionIcon>
                ) : null}
                <Text fw={700}>{rightPanelTitle}</Text>
              </Group>
              {isEditing ? (
                <Button
                  color="red"
                  variant="light"
                  size="xs"
                  onClick={() => setDeleteContactId(selectedContactId!)}
                >
                  Delete
                </Button>
              ) : null}
            </Group>

            {isNewMode || isEditing ? (
              <>
                <Group grow>
                  <TextInput
                    label="First Name"
                    placeholder="Jane"
                    value={form.firstName}
                    onChange={(e) => setForm((f) => ({ ...f, firstName: e.currentTarget.value }))}
                  />
                  <TextInput
                    label="Last Name"
                    placeholder="Doe"
                    value={form.lastName}
                    onChange={(e) => setForm((f) => ({ ...f, lastName: e.currentTarget.value }))}
                  />
                </Group>

                <TextInput
                  label="Email"
                  placeholder="jane@example.com"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.currentTarget.value }))}
                  required
                />

                <TagsInput
                  label="Tags"
                  description="Associate tags with this contact to use in newsletter distribution."
                  placeholder="Add tag and press Enter"
                  value={form.tags}
                  onChange={(tags) => setForm((f) => ({ ...f, tags }))}
                  data={allTags}
                  clearable
                />

                {error ? <Text c="red" size="sm">{error}</Text> : null}

                <Group>
                  <Button onClick={() => void onSave()} loading={isSubmitting}>
                    {isNewMode ? "Create Contact" : "Save Changes"}
                  </Button>
                  {isNewMode ? (
                    <Button
                      variant="default"
                      onClick={() => {
                        setIsNewMode(false);
                        setForm(emptyForm);
                        setError(null);
                        if (isMobile) setIsMobileEditorOpen(false);
                      }}
                    >
                      Cancel
                    </Button>
                  ) : null}
                </Group>

                {isNewMode ? (
                  <Stack gap="xs" mt="sm" style={{ borderTop: "1px solid var(--mantine-color-default-border)", paddingTop: 16 }}>
                    <Text fw={600} size="sm">Paste-import contacts</Text>
                    <Text size="xs" c="dimmed">
                      Paste a tab-separated list of contacts, one per line:{" "}
                      <Text component="span" ff="monospace" size="xs">
                        First Name⇥Last Name⇥Email⇥Tags (comma-separated)
                      </Text>
                    </Text>
                    <Textarea
                      placeholder={"Jane\tDoe\tjane@example.com\tnewsletter,vip\nJohn\tSmith\tjohn@example.com"}
                      value={importText}
                      onChange={(e) => {
                        setImportText(e.currentTarget.value);
                        setImportError(null);
                        setImportResult(null);
                      }}
                      minRows={5}
                      autosize
                      styles={{ input: { fontFamily: "monospace", fontSize: 13 } }}
                    />
                    {importError ? <Text c="red" size="sm">{importError}</Text> : null}
                    {importResult ? (
                      <Text c="teal" size="sm">
                        Imported {importResult.imported} contact(s){importResult.skipped > 0 ? `, skipped ${importResult.skipped}` : ""}.
                      </Text>
                    ) : null}
                    <Group>
                      <Button
                        variant="light"
                        size="sm"
                        onClick={() => void onImport()}
                        loading={isImporting}
                        disabled={!importText.trim()}
                      >
                        Import
                      </Button>
                    </Group>
                  </Stack>
                ) : null}
              </>
            ) : (
              <Center h={200}>
                <Text c="dimmed" size="sm">
                  Select a contact to edit, or create a new one.
                </Text>
              </Center>
            )}
          </Stack>
        </div>

      <Modal
        opened={Boolean(deleteContactId)}
        onClose={() => setDeleteContactId(null)}
        title="Confirm deletion"
        centered
      >
        <Stack>
          <Text size="sm">
            Delete{" "}
            {deleteContactId
              ? (contactDisplayName(contacts.find((c) => c.id === deleteContactId)!) || "this contact")
              : "this contact"}
            ? This action cannot be undone.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleteContactId(null)}>
              Cancel
            </Button>
            <Button color="red" onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}

function sortContacts(a: Contact, b: Contact): number {
  const aName = [a.firstName, a.lastName].filter(Boolean).join(" ").toLowerCase();
  const bName = [b.firstName, b.lastName].filter(Boolean).join(" ").toLowerCase();
  if (aName < bName) return -1;
  if (aName > bName) return 1;
  return a.email.localeCompare(b.email);
}
