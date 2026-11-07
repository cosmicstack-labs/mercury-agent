import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { NotchApp } from "./notch/NotchApp";
import "./styles/base.css";
import "./app/theme";

// The same bundle serves the main window and the voice capsule (?surface=notch).
const surface = new URLSearchParams(window.location.search).get("surface");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {surface === "notch" ? <NotchApp /> : <App />}
  </React.StrictMode>
);
// The code loaded and the app started: public/boot-guard.js stands down.
(window as Window & { __mercuryBooted?: boolean }).__mercuryBooted = true;
