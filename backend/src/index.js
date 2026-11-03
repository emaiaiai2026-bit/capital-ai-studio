import { createProviderRegistry } from "./providers/registry.js";
import { JobStore } from "./jobs/job-store.js";

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

function parseJobInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  const durationSeconds = Number(value.durationSeconds);
  const allowedDurations = [5, 10, 15];
  if (!prompt || prompt.length > 4000) return null;
  if (!allowedDurations.includes(durationSeconds)) return null;

  const aspectRatio = ["16:9", "9:16", "1:1"].includes(value.aspectRatio)
    ? value.aspectRatio : null;
  const visualStyle = typeof value.visualStyle === "string" && value.visualStyle.length <= 80
    ? value.visualStyle : null;
  const quality = ["480p", "768p", "1080p"].includes(value.quality) ? value.quality : null;
  if (!aspectRatio || !visualStyle || !quality) return null;

  return { prompt, durationSeconds, aspectRatio, visualStyle, quality };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return json({ ok: true, service: "capital-ai-studio-api", mode: "job-storage-foundation" });
    }

    if (request.method === "GET" && url.pathname === "/api/providers") {
      const providers = registry.list();
      return json({ providers, configured: providers.length > 0 });
    }

    if (request.method === "POST" && url.pathname === "/api/jobs") {
      let body;
      try { body = await request.json(); } catch { return json({ error: { code: "INVALID_JSON" } }, 400); }
      const input = parseJobInput(body);
      if (!input) {
        return json({ error: { code: "INVALID_JOB_INPUT", message: "A valid prompt and supported video settings are required." } }, 400);
      }

      const id = crypto.randomUUID();
      const store = env.JOB_STORE.get(env.JOB_STORE.idFromName(id));
      const job = await store.createJob({
        id,
        status: "draft",
        providerId: null,
        providerJobId: null,
        input,
        output: null,
        error: null,
      });
      return json({ job, generationStarted: false, note: "Saved as a draft only. No provider was called." }, 201);
    }

    const match = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})$/i);
    if (request.method === "GET" && match) {
      const store = env.JOB_STORE.get(env.JOB_STORE.idFromName(match[1]));
      const job = await store.getJob(match[1]);
      return job ? json({ job }) : json({ error: { code: "JOB_NOT_FOUND" } }, 404);
    }

    if (request.method === "POST" && url.pathname === "/api/jobs/submit") {
      return json({
        error: {
          code: "GENERATION_DISABLED",
          message: "Jobs can only be saved as drafts. Provider submission is not enabled.",
        },
      }, 409);
    }

    return json({ error: { code: "NOT_FOUND", message: "Route not found." } }, 404);
  },
};
