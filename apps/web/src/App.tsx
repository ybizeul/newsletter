import { type MouseEvent as ReactMouseEvent, useState } from "react";
import { ActionIcon, Anchor, AppShell, Box, Burger, Center, Group, Loader, Modal, NavLink, ScrollArea, Stack, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconAlignBoxCenterTop, IconArticle, IconClock, IconHelpCircle, IconList, IconLock, IconLogout, IconMail, IconStar, IconUser, IconAddressBook, IconWorld } from "@tabler/icons-react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";

import ArticlesPage from "./pages/ArticlesPage";
import ContactsPage from "./pages/ContactsPage";
import HeadersPage from "./pages/HeadersPage";
import LoginPage from "./pages/LoginPage";
import NewslettersPage from "./pages/NewslettersPage";
import NewsletterPreviewPage from "./pages/NewsletterPreviewPage";
import { AuthProvider, useAuth } from "./lib/auth";

const NAVBAR_WIDTH_STORAGE_KEY = "newsletter.navbar.width";

function getStoredNavbarWidth(): number {
  const raw = window.localStorage.getItem(NAVBAR_WIDTH_STORAGE_KEY);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return 260;
  }
  return Math.min(Math.max(parsed, 200), 700);
}

function App() {
  const { user, loading, oidcEnabled, contactsDisabled, logout } = useAuth();
  const [opened, { toggle, close }] = useDisclosure();
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [navbarWidth, setNavbarWidth] = useState(getStoredNavbarWidth);
  const location = useLocation();
  const navigate = useNavigate();

  const startNavbarResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();

    const onMouseMove = (moveEvent: MouseEvent) => {
      const minWidth = 200;
      const maxWidth = Math.max(minWidth, window.innerWidth - 520);
      const nextWidth = Math.min(Math.max(moveEvent.clientX, minWidth), maxWidth);
      setNavbarWidth(nextWidth);
      window.localStorage.setItem(NAVBAR_WIDTH_STORAGE_KEY, String(nextWidth));
    };

    const onMouseUp = () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  if (loading) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }

  if (oidcEnabled && !user) {
    return <LoginPage />;
  }

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{
        width: { base: "100%", sm: navbarWidth },
        breakpoint: "sm",
        collapsed: { mobile: !opened }
      }}
      padding={0}
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <Text fw={700} truncate>
              Newsletter Workspace
            </Text>
          </Group>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="lg"
            aria-label="Open help"
            title="How it works"
            onClick={() => setIsHelpOpen(true)}
          >
            <IconHelpCircle size={18} />
          </ActionIcon>
          {oidcEnabled && user && (
            <Group gap="xs" wrap="nowrap">
              <Text size="sm" c="dimmed" truncate style={{ maxWidth: 160 }}>
                {user.name || user.email}
              </Text>
              <ActionIcon variant="subtle" color="gray" size="lg" aria-label="Logout" title="Logout" onClick={logout}>
                <IconLogout size={18} />
              </ActionIcon>
            </Group>
          )}
        </Group>
      </AppShell.Header>

      <Modal
        opened={isHelpOpen}
        onClose={() => setIsHelpOpen(false)}
        title="How Newsletter builder works"
        size="lg"
        centered
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            This workspace helps you maintain a reusable content library and assemble targeted newsletters quickly.
          </Text>

          <Box
            style={{
              border: "1px solid #e9ecef",
              borderRadius: 8,
              padding: 12,
              background: "#f8f9fa"
            }}
          >
            <Text fw={600} size="sm" mb={6}>Table of contents</Text>
            <Group gap="md" wrap="wrap">
              <Anchor size="sm" href="#help-articles">Articles</Anchor>
              <Anchor size="sm" href="#help-newsletters">Newsletters</Anchor>
              <Anchor size="sm" href="#help-headers">Headers</Anchor>
              <Anchor size="sm" href="#help-find">Find content faster</Anchor>
              <Anchor size="sm" href="#help-favorite">Favorite workflow</Anchor>
              <Anchor size="sm" href="#help-clues">Visual clues</Anchor>
            </Group>
          </Box>

          <ScrollArea h={360} offsetScrollbars>
            <Stack gap="lg" pr="xs">
              <Box id="help-articles">
                <Text fw={700} size="sm" mb={4}>Write and share articles</Text>
                <Text size="sm">Create articles in the Articles page, write in Markdown, add optional tags, and maintain reusable content blocks for future newsletters.</Text>
              </Box>
              <Box id="help-headers">
                <Text fw={700} size="sm" mb={4}>Create custom headers for specific audiences</Text>
                <Text size="sm">Use reusable headers to tailor branding, tone, or campaign context for each audience segment without rewriting each newsletter from scratch.</Text>
              </Box>
              <Box id="help-newsletters">
                <Text fw={700} size="sm" mb={4}>Create newsletters with selected articles</Text>
                <Text size="sm">In the Newsletters page, compose your intro, select a header, add and reorder articles, then preview or send. Autosave keeps your newsletter edits up to date.</Text>
              </Box>
              <Box id="help-find">
                <Text fw={700} size="sm" mb={4}>Use tags, filters, and search to find content quickly</Text>
                <Text size="sm">Tag articles by topic, then filter and search in the list to locate relevant content fast when building a newsletter edition.</Text>
              </Box>

              <Box id="help-favorite">
                <Text fw={700} size="sm" mb={4}>Favorite one newsletter for rapid curation</Text>
                <Text size="sm">Set one newsletter as favorite, then use the article editor action to add or remove the current article from that newsletter in one click.</Text>
              </Box>
              <Box id="help-clues">
                <Text fw={700} size="sm" mb={4}>Understand visual clues</Text>
                <Stack gap={6}>
                  <Group gap={6} wrap="nowrap">
                    <IconStar size={14} fill="#fcc419" color="#f59f00" />
                    <Text size="sm">Yellow star: marks the favorite newsletter in the newsletter list.</Text>
                  </Group>
                  <Group gap={6} wrap="nowrap">
                    <IconMail size={14} color="#228be6" />
                    <Text size="sm">Blue envelope: marks articles already included in the favorite newsletter.</Text>
                  </Group>
                  <Group gap={6} wrap="nowrap" align="center">
                    <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: "#228be6", flexShrink: 0 }} />
                    <Text size="sm">Blue dot: marks articles not yet used in any newsletter.</Text>
                  </Group>
                </Stack>
              </Box>
              <Box id="help-workflow">
                <Text fw={700} size="sm" mb={4}>Standard workflow</Text>
                <Text size="sm">1. Create a newsletter, and mrk is as favorite using the yellow star</Text>
                <Text size="sm">2. Browse articles using the smart lists on the left to easily identify relevant content</Text>
                <Text size="sm">3. The blue dot helps you identify articles that's not in any newsletters</Text>
                <Text size="sm">4. It helps to display only unused articles with the toggle next to the search field</Text>
              </Box>
            </Stack>
          </ScrollArea>
        </Stack>
      </Modal>

      <AppShell.Navbar p="sm">
        <Box mb="xs">
          <Group gap="xs" px="sm" py={6} style={{ borderRadius: 6, background: "transparent" }}>
            <IconArticle size={16} />
            <Text size="sm" fw={500}>Articles</Text>
          </Group>
          <Box pl="md">
          <NavLink
            label="All"
            active={location.pathname === "/articles" || location.pathname === "/articles/all"}
            variant="subtle"
            color="blue"
            style={{ backgroundColor: "transparent" }}
            leftSection={<IconList size={14} />}
            onClick={() => {
              navigate("/articles/all");
              close();
            }}
          />
          <NavLink
            label="Mine"
            active={location.pathname === "/articles/mine"}
            variant="subtle"
            color="blue"
            style={{ backgroundColor: "transparent" }}
            leftSection={<IconUser size={14} />}
            onClick={() => {
              navigate("/articles/mine");
              close();
            }}
          />
          <NavLink
            label="Private"
            active={location.pathname === "/articles/private"}
            variant="subtle"
            color="blue"
            style={{ backgroundColor: "transparent" }}
            leftSection={<IconLock size={14} />}
            onClick={() => {
              navigate("/articles/private");
              close();
            }}
          />
          {oidcEnabled && (
          <NavLink
            label="Public"
            active={location.pathname === "/articles/public"}
            variant="subtle"
            color="blue"
            style={{ backgroundColor: "transparent" }}
            leftSection={<IconWorld size={14} />}
            onClick={() => {
              navigate("/articles/public");
              close();
            }}
          />
          )}
          <NavLink
            label="Recent"
            active={location.pathname === "/articles/recent"}
            variant="subtle"
            color="blue"
            style={{ backgroundColor: "transparent" }}
            leftSection={<IconClock size={14} />}
            onClick={() => {
              navigate("/articles/recent");
              close();
            }}
          />
          </Box>
        </Box>
        <NavLink
          label="Newsletters"
          active={location.pathname.startsWith("/newsletters")}
          leftSection={<IconMail size={16} />}
          onClick={() => {
            navigate("/newsletters");
            close();
          }}
        />
        <NavLink
          label="Headers"
          active={location.pathname.startsWith("/headers")}
          leftSection={<IconAlignBoxCenterTop size={16} />}
          onClick={() => {
            navigate("/headers");
            close();
          }}
        />
        {!contactsDisabled ? (
          <NavLink
            label="Contacts"
            active={location.pathname.startsWith("/contacts")}
            leftSection={<IconAddressBook size={16} />}
            onClick={() => {
              navigate("/contacts");
              close();
            }}
          />
        ) : null}
      </AppShell.Navbar>

      <Box
        visibleFrom="sm"
        onMouseDown={startNavbarResize}
        style={{
          position: "fixed",
          top: 60,
          bottom: 0,
          left: navbarWidth - 4,
          width: 8,
          cursor: "col-resize",
          zIndex: 200,
          background: "linear-gradient(to right, transparent 3px, #e9ecef 3px, #e9ecef 4px, transparent 4px)"
        }}
      />

      <AppShell.Main>
        <Routes>
          <Route path="/articles" element={<Navigate to="/articles/all" replace />} />
          <Route path="/articles/public" element={oidcEnabled ? <ArticlesPage /> : <Navigate to="/articles/all" replace />} />
          <Route path="/articles/:smartFilter" element={<ArticlesPage />} />
          <Route path="/newsletters" element={<NewslettersPage />} />
          <Route path="/headers" element={<HeadersPage />} />
          <Route path="/contacts" element={contactsDisabled ? <Navigate to="/articles" replace /> : <ContactsPage />} />
          <Route path="/newsletters/:id/preview" element={<NewsletterPreviewPage />} />
          <Route path="*" element={<Navigate to="/articles" replace />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}

export default function AppWithAuth() {
  return (
    <AuthProvider>
      <App />
    </AuthProvider>
  );
}
