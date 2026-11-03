import { createProviderRegistry } from "./providers/registry.js";
import { JobStore } from "./jobs/job-store.js";

// Wrangler binds this Durable Object by its named export from the Worker entrypoint.
export { JobStore };
import { handleGoogleAuth, getSession, logoutResponse } from "./auth/google-oauth.js";

const registry = createProviderRegistry([]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function hasTrustedOrigin(request, env) {
  try {
    return Boolean(env.APP_ORIGIN) && request.headers.get("Origin") === new URL(env.APP_ORIGIN).origin;
  } catch { return false; }
}

function parseJobInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  const durationSeconds = Number(value.durationSeconds);
  if (!prompt || prompt.length > 4000 || ![5, 10, 15].includes(durationSeconds)) return null;
  const aspectRatio = ["16:9", "9:16", "1:1"].includes(value.aspectRatio) ? value.aspectRatio : null;
  const visualStyle = typeof value.visualStyle === "string" && value.visualStyle.length <= 80 ? value.visualStyle : null;
  const quality = ["480p", "768p", "1080p"].includes(value.quality) ? value.quality : null;
  if (!aspectRatio || !visualStyle || !quality) return null;
  return { prompt, durationSeconds, aspectRatio, visualStyle, quality };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      const authResponse = await handleGoogleAuth(request, env, url.pathname);
      if (authResponse) return authResponse;
    } catch (error) {
      console.error(JSON.stringify({ event: "google_auth_error", message: error?.message || "unknown" }));
      return json({ error: { code: "AUTH_FAILED", message: "Google sign-in could not be completed." } }, 500);
    }

    if (request.method === "POST" && url.pathname === "/auth/logout") {
      if (!hasTrustedOrigin(request, env)) return json({ error: { code: "ORIGIN_REJECTED" } }, 403);
      return logoutResponse();
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      return json({ ok: true, service: "capital-ai-studio-api", mode: "draft-storage-only", authConfigured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET && env.APP_ORIGIN) });
    }
    if (request.method === "GET" && url.pathname === "/api/me") {
      const user = await getSession(request, env);
      return user ? json({ authenticated: true, user }) : json({ authenticated: false }, 401);
    }
    if (request.method === "GET" && url.pathname === "/api/providers") {
      const providers = registry.list();
      return json({ providers, configured: providers.length > 0 });
    }

    if (request.method === "POST" && url.pathname === "/api/jobs") {
      if (!hasTrustedOrigin(request, env)) return json({ error: { code: "ORIGIN_REJECTED" } }, 403);
      const user = await getSession(request, env);
      if (!user) return json({ error: { code: "UNAUTHORIZED" } }, 401);
      let body;
      try { body = await request.json(); } catch { return json({ error: { code: "INVALID_JSON" } }, 400); }
      const input = parseJobInput(body);
      if (!input) return json({ error: { code: "INVALID_JOB_INPUT", message: "A valid prompt and supported video settings are required." } }, 400);
      const id = crypto.randomUUID();
      const store = env.JOB_STORE.get(env.JOB_STORE.idFromName(id));
      const job = await store.createJob({ id, ownerId: user.sub, status: "draft", providerId: null, providerJobId: null, input, output: null, error: null });
      return json({ job, generationStarted: false, note: "Saved as a draft only. No provider was called." }, 201);
    }

    const match = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})$/i);
    if (request.method === "GET" && match) {
      const user = await getSession(request, env);
      if (!user) return json({ error: { code: "UNAUTHORIZED" } }, 401);
      const store = env.JOB_STORE.get(env.JOB_STORE.idFromName(match[1]));
      const job = await store.getJob(match[1]);
      if (!job || job.ownerId !== user.sub) return json({ error: { code: "JOB_NOT_FOUND" } }, 404);
      return json({ job });
    }

    if (request.method === "POST" && url.pathname === "/api/jobs/submit") {
      return json({ error: { code: "GENERATION_DISABLED", message: "Jobs can only be saved as drafts. Provider submission is not enabled." } }, 409);
    }
    return json({ error: { code: "NOT_FOUND", message: "Route not found." } }, 404);
  },
};
