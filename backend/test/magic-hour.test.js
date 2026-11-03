import { describe, expect, it, vi } from "vitest";
import { createMagicHourProvider } from "../src/providers/magic-hour.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Magic Hour provider adapter", () => {
  it("reads account credits without creating a billable job", async () => {
    const fetchImpl = vi.fn(async () => json({
      tier: "free",
      credits: 120,
      subscription: null,
    }));
    const provider = createMagicHourProvider({ apiKey: "test-key", fetchImpl });

    await expect(provider.getAccount()).resolves.toEqual({
      tier: "free",
      credits: 120,
      subscription: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://api.magichour.ai/v1/account");
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe("Bearer test-key");
  });

  it("submits text-to-video using the low-cost default model and resolution", async () => {
    const fetchImpl = vi.fn(async () => json({ id: "video-project-1", credits_charged: 42 }));
    const provider = createMagicHourProvider({ apiKey: "test-key", fetchImpl });

    const result = await provider.createJob({
      input: {
        prompt: "A cinematic sunrise over an Egyptian village",
        durationSeconds: 5,
        aspectRatio: "9:16",
      },
    });

    expect(result).toEqual({ id: "video-project-1", creditsCharged: 42 });
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://api.magichour.ai/v1/text-to-video");
    const payload = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(payload).toMatchObject({
      end_seconds: 5,
      aspect_ratio: "9:16",
      model: "ltx-2.5",
      resolution: "480p",
      audio: false,
      style: { prompt: "A cinematic sunrise over an Egyptian village" },
    });
  });

  it("uploads a reference image and submits image-to-video", async () => {
    const fetchImpl = vi.fn(async (url, init = {}) => {
      const target = String(url);
      if (target === "https://api.magichour.ai/v1/files/upload-urls") {
        return json({ items: [{
          upload_url: "https://videos.magichour.ai/api-assets/test/image.png?token=upload",
          file_path: "api-assets/test/image.png",
        }] });
      }
      if (target.startsWith("https://videos.magichour.ai/")) {
        expect(init.method).toBe("PUT");
        return new Response(null, { status: 200 });
      }
      if (target === "https://api.magichour.ai/v1/image-to-video") {
        return json({ id: "image-project-1", credits_charged: 55 });
      }
      throw new Error("Unexpected provider URL: " + target);
    });
    const provider = createMagicHourProvider({ apiKey: "test-key", fetchImpl });
    const imageFile = new File([new Uint8Array([1, 2, 3])], "reference.png", { type: "image/png" });

    const result = await provider.createJob({
      input: {
        prompt: "Slow cinematic camera movement",
        durationSeconds: 5,
        aspectRatio: "16:9",
      },
      imageFile,
    });

    expect(result.id).toBe("image-project-1");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const generationPayload = JSON.parse(fetchImpl.mock.calls[2][1].body);
    expect(generationPayload.assets.image_file_path).toBe("api-assets/test/image.png");
    expect(generationPayload.model).toBe("ltx-2.5");
  });

  it("normalizes completed projects and exposes their expiring download link", async () => {
    const fetchImpl = vi.fn(async () => json({
      id: "video-project-2",
      status: "complete",
      credits_charged: 50,
      downloads: [{ url: "https://videos.magichour.ai/output.mp4", expires_at: "2026-11-04T00:00:00Z" }],
    }));
    const provider = createMagicHourProvider({ apiKey: "test-key", fetchImpl });

    await expect(provider.getJob("video-project-2")).resolves.toMatchObject({
      id: "video-project-2",
      status: "completed",
      providerStatus: "complete",
      creditsCharged: 50,
      output: { videoUrl: "https://videos.magichour.ai/output.mp4" },
    });
  });

  it("surfaces insufficient-credit errors without retrying a paid request", async () => {
    const fetchImpl = vi.fn(async () => json({
      code: "insufficient_credits",
      message: "Not enough credits",
    }, 402));
    const provider = createMagicHourProvider({ apiKey: "test-key", fetchImpl });

    await expect(provider.createJob({
      input: { prompt: "Test", durationSeconds: 5, aspectRatio: "16:9" },
    })).rejects.toMatchObject({ code: "insufficient_credits", status: 402 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
