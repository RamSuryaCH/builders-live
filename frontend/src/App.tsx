import { useEffect, useState } from "react";
import { loadConfig } from "@shared/event-config";
import { Host } from "./pages/Host";
import { Join } from "./pages/Join";
import { Landing } from "./pages/Landing";
import { Play } from "./pages/Play";
import { Screen } from "./pages/Screen";

const event = loadConfig();

function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return path;
}

export function App() {
  const path = usePath();
  const join = path.match(/^\/join\/([A-Za-z0-9]{4,8})\/?$/);
  const play = path.match(/^\/play\/([A-Za-z0-9]{4,8})\/?$/);
  const screen = path.match(/^\/screen\/([A-Za-z0-9]{4,8})\/?$/);
  if (path === "/host") return <Host eventName={event.eventName} />;
  if (join) return <Join code={join[1].toUpperCase()} eventName={event.eventName} />;
  if (play) return <Play code={play[1].toUpperCase()} />;
  if (screen) return <Screen code={screen[1].toUpperCase()} eventName={event.eventName} />;
  return <Landing eventName={event.eventName} tagline={event.tagline} groupName={event.groupName} />;
}
