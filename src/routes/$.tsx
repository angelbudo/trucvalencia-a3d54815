import { createFileRoute } from "@tanstack/react-router";
import { ClientOnly } from "@/components/ClientOnly";
import App from "@/App";

export const Route = createFileRoute("/$")({
  head: () => ({ meta: [
    { title: "iTruc Valencià — Partides i comunitat" },
    { name: "description", content: "Partides, sales i comunitat de jugadors de Truc valencià." },
    { property: "og:title", content: "iTruc Valencià — Partides i comunitat" },
    { property: "og:description", content: "Partides, sales i comunitat de jugadors de Truc valencià." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: () => (
    <ClientOnly>
      <App />
    </ClientOnly>
  ),
});
