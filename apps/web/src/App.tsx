import { AppShell, Burger, Group, NavLink, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconArticle, IconMail } from "@tabler/icons-react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import ArticlesPage from "./pages/ArticlesPage";
import NewslettersPage from "./pages/NewslettersPage";
import NewsletterPreviewPage from "./pages/NewsletterPreviewPage";

function App() {
  const [opened, { toggle }] = useDisclosure();
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{
        width: 260,
        breakpoint: "sm",
        collapsed: { mobile: !opened }
      }}
      padding={0}
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group>
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <Text fw={700}>Newsletter Workspace</Text>
          </Group>
          <Text size="sm" c="dimmed">
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
      </AppShell.Navbar>

      <AppShell.Main>
        <Routes>
          <Route path="/articles" element={<ArticlesPage />} />
          <Route path="/newsletters" element={<NewslettersPage />} />
          <Route path="/newsletters/:id/preview" element={<NewsletterPreviewPage />} />
          <Route path="*" element={<Navigate to="/articles" replace />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
  );
}

export default App;
