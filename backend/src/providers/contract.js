/**
 * Provider-neutral contract for future video-generation adapters.
 * This file contains no provider endpoints, credentials, or network calls.
 */
export const PROVIDER_CAPABILITIES = Object.freeze({
  textToVideo: "text_to_video",
  imageToVideo: "image_to_video",
});

export function validateProviderAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new TypeError("Provider adapter must be an object.");
  }
  if (typeof adapter.id !== "string" || !adapter.id.trim()) {
    throw new TypeError("Provider adapter must define a stable id.");
  }
  if (typeof adapter.getCapabilities !== "function") {
    throw new TypeError("Provider adapter must implement getCapabilities().");
  }
  if (typeof adapter.createJob !== "function" || typeof adapter.getJob !== "function") {
    throw new TypeError("Provider adapter must implement createJob() and getJob().");
  }
  return adapter;
}

/**
 * Normalize provider-specific job states to one app-wide vocabulary.
 */
export function normalizeJobStatus(status) {
  const value = String(status || "").toLowerCase();
  if (["queued", "pending", "waiting"].includes(value)) return "queued";
  if (["processing", "running", "in_progress"].includes(value)) return "processing";
  if (["completed", "complete", "succeeded", "success"].includes(value)) return "completed";
  if (["failed", "error", "cancelled", "canceled"].includes(value)) return "failed";
  return "unknown";
}
