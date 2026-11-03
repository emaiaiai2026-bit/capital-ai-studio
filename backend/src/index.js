import { createProviderRegistry } from "./providers/registry.js";

const registry = createProviderRegistry([]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return json({ ok: true, service: "capital-ai-studio-api", mode: "adapter-foundation" });
    }

    if (request.method === "GET" && url.pathname === "/api/providers") {
      return json({ providers: registry.list(), configured: registry.list().length > 0 });
    }

    if (request.method === "POST" && url.pathname === "/api/jobs") {
      // Intentionally fail closed: no adapter is registered and no provider can be called.
      return json({
        error: {
          code: "PROVIDER_NOT_CONFIGURED",
          message: "No video provider is configured. No generation request was sent.",
        },
      }, 503);
    }

    return json({ error: { code: "NOT_FOUND", message: "Route not found." } }, 404);
  },
};
