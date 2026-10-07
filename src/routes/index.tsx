import { createFileRoute } from "@tanstack/react-router";
import { ClientOnly } from "@/components/ClientOnly";
import App from "@/App";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [
    { title: "iTruc Valencià — Juga al Truc" },
    { name: "description", content: "Juga al Truc valencià amb bots o amb altres jugadors." },
    { property: "og:title", content: "iTruc Valencià — Juga al Truc" },
    { property: "og:description", content: "Juga al Truc valencià amb bots o amb altres jugadors." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: () => (
    <ClientOnly>
      <App />
    </ClientOnly>
  ),
});
