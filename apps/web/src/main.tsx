import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { MantineProvider, createTheme } from "@mantine/core";
import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";
import "./styles/_variables.scss";
import "./styles/_keyframe-animations.scss";
import App from "./App";

// Safari PWA fix: intercept same-origin <a> clicks so navigation stays in-app
// instead of opening a new Safari window with a close button.
if ("standalone" in window.navigator && (window.navigator as any).standalone) {
  document.addEventListener("click", (e) => {
    const anchor = (e.target as HTMLElement).closest("a");
    if (!anchor || !anchor.href) return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    if (anchor.target === "_blank") return;
    e.preventDefault();
    const dest = url.pathname + url.search + url.hash;
    if (dest !== window.location.pathname + window.location.search + window.location.hash) {
      window.history.pushState({}, "", dest);
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    }
  });
}

const theme = createTheme({
  fontFamily: "'Space Grotesk', 'Segoe UI', sans-serif",
  components: {
    InputWrapper: {
      styles: {
        label: {
          fontWeight: 700
        }
      }
    }
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </MantineProvider>
  </React.StrictMode>
);
