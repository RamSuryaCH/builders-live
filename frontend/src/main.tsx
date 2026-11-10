import "@fontsource/outfit/400.css";
import "@fontsource/outfit/500.css";
import "@fontsource/outfit/700.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
const applyMotion = () => document.documentElement.classList.toggle("reduce-motion", motion.matches);
applyMotion();
motion.addEventListener?.("change", applyMotion);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
