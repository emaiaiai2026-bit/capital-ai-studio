const API = "https://api.magichour.ai";
const DEFAULT_MODEL = "ltx-2.5";

function safeMessage(body, fallback) {
  const code = typeof body?.code === "string" ? body.code : "PROVIDER_ERROR";
  const message = typeof body?.message === "string" ? body.message.slice(0, 240) : fallback;
  return { code, message };
}

export function createMagicHourProvider({ apiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error("MAGIC_HOUR_NOT_CONFIGURED");

  async function request(path, init = {}) {
    const response = await fetchImpl(new URL(path, API), {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const issue = safeMessage(body, `Magic Hour request failed (${response.status}).`);
      const error = new Error(issue.message);
      error.code = issue.code;
      error.status = response.status;
      throw error;
    }
    return body;
  }

  return Object.freeze({
    id: "magic-hour",
    getCapabilities() {
      return ["text_to_video", "image_to_video"];
    },
    async getAccount() {
      const account = await request("/v1/account");
      return {
        tier: account.tier || "unknown",
        credits: Number.isFinite(account.credits) ? account.credits : null,
        subscription: account.subscription?.name || null,
      };
    },
    async createJob({ input, imageFile = null, name = "Capital AI Studio video" }) {
      let endpoint = "/v1/text-to-video";
      let body = {
        name,
        end_seconds: input.durationSeconds,
        aspect_ratio: input.aspectRatio,
        model: DEFAULT_MODEL,
        resolution: "480p",
        audio: false,
        style: { prompt: input.prompt },
      };

      if (imageFile) {
        const extension = imageFile.type === "image/png" ? "png"
          : imageFile.type === "image/webp" ? "webp" : "jpg";
        const upload = await request("/v1/files/upload-urls", {
          method: "POST",
          body: JSON.stringify({ items: [{ type: "image", extension }] }),
        });
        const target = upload.items?.[0];
        if (!target?.upload_url || !target?.file_path) {
          throw new Error("PROVIDER_UPLOAD_URL_MISSING");
        }
        const uploadUrl = new URL(target.upload_url);
        if (uploadUrl.protocol !== "https:" || !uploadUrl.hostname.endsWith(".magichour.ai")) {
          throw new Error("PROVIDER_UPLOAD_URL_REJECTED");
        }
        const uploaded = await fetchImpl(uploadUrl, {
          method: "PUT",
          headers: { "content-type": imageFile.type || "application/octet-stream" },
          body: await imageFile.arrayBuffer(),
        });
        if (!uploaded.ok) throw new Error("PROVIDER_IMAGE_UPLOAD_FAILED");
        endpoint = "/v1/image-to-video";
        body = {
          ...body,
          assets: { image_file_path: target.file_path },
        };
      }

      const created = await request(endpoint, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!created.id) throw new Error("PROVIDER_JOB_ID_MISSING");
      return {
        id: created.id,
        creditsCharged: Number.isFinite(created.credits_charged) ? created.credits_charged : null,
      };
    },
    async getJob(id) {
      const project = await request(`/v1/video-projects/${encodeURIComponent(id)}`);
      const statusMap = {
        draft: "queued",
        queued: "queued",
        rendering: "processing",
        complete: "completed",
        error: "failed",
        canceled: "failed",
      };
      return {
        id: project.id,
        status: statusMap[project.status] || "unknown",
        providerStatus: project.status,
        creditsCharged: Number.isFinite(project.credits_charged) ? project.credits_charged : null,
        output: project.status === "complete" && project.downloads?.[0]?.url
          ? { videoUrl: project.downloads[0].url, expiresAt: project.downloads[0].expires_at || null }
          : null,
        error: project.error || null,
      };
    },
  });
}
