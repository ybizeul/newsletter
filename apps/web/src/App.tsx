import { type MouseEvent as ReactMouseEvent, useState } from "react";
import { AppShell, Box, Burger, Group, NavLink, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconAlignBoxCenterTop, IconArticle, IconMail } from "@tabler/icons-react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import ArticlesPage from "./pages/ArticlesPage";
import HeadersPage from "./pages/HeadersPage";
import NewslettersPage from "./pages/NewslettersPage";
import NewsletterPreviewPage from "./pages/NewsletterPreviewPage";

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
  const [opened, { toggle }] = useDisclosure();
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

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{
        width: navbarWidth,
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
          <Text size="sm" c="dimmed" truncate>
            MVP Foundation
          </Text>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <NavLink
          label="Articles"
          active={location.pathname.startsWith("/articles")}
          leftSection={<IconArticle size={16} />}
          onClick={() => navigate("/articles")}
        />
        <NavLink
          label="Newsletters"
          active={location.pathname.startsWith("/newsletters")}
          leftSection={<IconMail size={16} />}
          onClick={() => navigate("/newsletters")}
        />
        <NavLink
          label="Headers"
          active={location.pathname.startsWith("/headers")}
          leftSection={<IconAlignBoxCenterTop size={16} />}
          onClick={() => navigate("/headers")}
        />
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
          <Route path="/articles" element={<ArticlesPage />} />
          <Route path="/newsletters" element={<NewslettersPage />} />
          <Route path="/headers" element={<HeadersPage />} />
          <Route path="/newsletters/:id/preview" element={<NewsletterPreviewPage />} />
          <Route path="*" element={<Navigate to="/articles" replace />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}

export default App;
