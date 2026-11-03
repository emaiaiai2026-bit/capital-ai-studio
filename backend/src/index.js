import { createProviderRegistry } from "./providers/registry.js";
import { JobStore } from "./jobs/job-store.js";
import { createMagicHourProvider } from "./providers/magic-hour.js";

// Wrangler binds this Durable Object by its named export from the Worker entrypoint.
export { JobStore };
import { handleGoogleAuth, getSession, logoutResponse } from "./auth/google-oauth.js";

const registry = createProviderRegistry([]);

function getMagicHour(env) {
  return env.MAGIC_HOUR_API_KEY ? createMagicHourProvider({ apiKey: env.MAGIC_HOUR_API_KEY }) : null;
}

function mapProviderError(error) {
  const code = error?.code || "VIDEO_PROVIDER_FAILED";
  const status = error?.status === 402 ? 402 : 502;
  return json({ error: { code, message: error?.message || "تعذر الاتصال بمحرك الفيديو." } }, status);
}

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
      const providers = [
        ...registry.list(),
        ...(env.MAGIC_HOUR_API_KEY ? [{ id: "magic-hour", capabilities: ["text_to_video", "image_to_video"], defaultModel: "ltx-2.5", defaultResolution: "480p" }] : []),
      ];
      return json({ providers, configured: providers.length > 0 });
    }

    if (request.method === "GET" && url.pathname === "/api/provider/account") {
      const user = await getSession(request, env);
      if (!user) return json({ error: { code: "UNAUTHORIZED" } }, 401);
      const provider = getMagicHour(env);
      if (!provider) return json({ error: { code: "PROVIDER_NOT_CONFIGURED" } }, 503);
      try {
        return json({ provider: "magic-hour", account: await provider.getAccount() });
      } catch (error) {
        return mapProviderError(error);
      }
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
      let job = await store.getJob(match[1]);
      if (!job || job.ownerId !== user.sub) return json({ error: { code: "JOB_NOT_FOUND" } }, 404);

      if (job.providerId === "magic-hour" && job.providerJobId && ["queued", "processing"].includes(job.status)) {
        try {
          const remote = await getMagicHour(env).getJob(job.providerJobId);
          if (remote.status !== "unknown" && remote.status !== job.status) {
            const next = await store.transitionJob(job.id, remote.status, {
              providerStatus: remote.providerStatus,
              ...(remote.output ? { output: remote.output } : {}),
              ...(remote.error ? { error: remote.error } : {}),
            });
            if (next.ok) job = next.job;
          }
        } catch (error) {
          console.error(JSON.stringify({ event: "provider_status_check_failed", jobId: job.id, code: error?.code || "PROVIDER_ERROR" }));
        }
      }
      return json({ job });
    }

    if (request.method === "POST" && url.pathname === "/api/jobs/submit") {
      if (!hasTrustedOrigin(request, env)) return json({ error: { code: "ORIGIN_REJECTED" } }, 403);
      const user = await getSession(request, env);
      if (!user) return json({ error: { code: "UNAUTHORIZED" } }, 401);
      const provider = getMagicHour(env);
      if (!provider) return json({ error: { code: "PROVIDER_NOT_CONFIGURED" } }, 503);

      let values;
      let imageFile = null;
      try {
        if ((request.headers.get("content-type") || "").includes("multipart/form-data")) {
          const form = await request.formData();
          values = Object.fromEntries(["prompt", "durationSeconds", "aspectRatio", "visualStyle", "quality"].map((key) => [key, form.get(key)]));
          const image = form.get("image");
          if (image && typeof image === "object" && typeof image.arrayBuffer === "function" && image.size > 0) {
            if (image.size > 10 * 1024 * 1024) return json({ error: { code: "IMAGE_TOO_LARGE" } }, 413);
            if (!["image/jpeg", "image/png", "image/webp"].includes(image.type)) return json({ error: { code: "INVALID_IMAGE_TYPE" } }, 400);
            imageFile = image;
          }
        } else {
          values = await request.json();
        }
      } catch {
        return json({ error: { code: "INVALID_REQUEST_BODY" } }, 400);
      }

      const input = parseJobInput(values);
      if (!input) return json({ error: { code: "INVALID_JOB_INPUT", message: "A valid prompt and supported video settings are required." } }, 400);
      const id = crypto.randomUUID();
      const store = env.JOB_STORE.get(env.JOB_STORE.idFromName(id));
      await store.createJob({ id, ownerId: user.sub, status: "draft", providerId: null, providerJobId: null, input, output: null, error: null });
      const queued = await store.transitionJob(id, "queued", { providerId: "magic-hour", note: "Submitted to the selected video provider." });
      if (!queued.ok) return json({ error: { code: queued.error } }, 500);

      try {
        const remote = await provider.createJob({ input, imageFile, name: "Capital AI Studio - " + id });
        const attached = await store.transitionJob(id, "queued", {
          providerId: "magic-hour",
          providerJobId: remote.id,
          creditsCharged: remote.creditsCharged,
          providerStatus: "submitted",
        });
        if (!attached.ok) {
          console.error(JSON.stringify({ event: "provider_job_attach_failed", jobId: id, providerJobId: remote.id }));
          return json({ error: { code: "JOB_TRACKING_FAILED", message: "تم إرسال الفيديو للمزود لكن تعذر حفظ رقم المهمة. تواصل مع الدعم قبل إعادة المحاولة." } }, 500);
        }
        return json({
          job: attached.job,
          generationStarted: true,
          provider: "magic-hour",
          creditsCharged: remote.creditsCharged,
          note: "تم إرسال طلب التوليد. قد يتم خصم رصيد من حساب مزود الفيديو.",
        }, 202);
      } catch (error) {
        await store.transitionJob(id, "failed", { error: { code: error?.code || "PROVIDER_SUBMISSION_FAILED", message: error?.message || "تعذر إرسال المهمة للمزود." } });
        return mapProviderError(error);
      }
    }
    return json({ error: { code: "NOT_FOUND", message: "Route not found." } }, 404);
  },
};
