import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { MantineProvider, createTheme } from "@mantine/core";
import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";
import "./styles/_variables.scss";
import "./styles/_keyframe-animations.scss";
import App from "./App";

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
    <MantineProvider theme={theme} defaultColorScheme="light">
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </MantineProvider>
  </React.StrictMode>
);
