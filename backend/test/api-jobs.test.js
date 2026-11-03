import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";

const APP_ORIGIN = "https://studio.example.test";
const SESSION_SECRET = "integration-test-secret-with-more-than-32-bytes";

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
}

async function signedSessionCookie() {
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(new TextEncoder().encode(JSON.stringify({
    sub: "integration-user-1",
    email: "integration@example.test",
    name: "Integration Test",
    picture: "",
    iat: now,
    exp: now + 3600,
  })));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return "__Host-capital_session=" + payload + "." + base64url(new Uint8Array(signature));
}

function testEnv() {
  return { ...env, APP_ORIGIN, SESSION_SECRET };
}

describe("Worker API integration", () => {
  it("keeps the health route available before Google OAuth is configured", async () => {
    const response = await worker.fetch(
      new Request("https://studio.example.test/api/health"),
      { ...env, APP_ORIGIN: undefined, GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined, SESSION_SECRET: undefined }
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.authConfigured).toBe(false);
  });

  it("saves an authenticated draft and retrieves it through the HTTP API", async () => {
    const cookie = await signedSessionCookie();
    const createResponse = await worker.fetch(
      new Request("https://studio.example.test/api/jobs", {
        method: "POST",
        headers: {
          Origin: APP_ORIGIN,
          Cookie: cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: "A cinematic sunrise over an Egyptian village",
          durationSeconds: 5,
          aspectRatio: "16:9",
          visualStyle: "cinematic",
          quality: "768p",
        }),
      }),
      testEnv()
    );

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    expect(created.generationStarted).toBe(false);
    expect(created.job.status).toBe("draft");
    expect(created.job.ownerId).toBe("integration-user-1");

    const getResponse = await worker.fetch(
      new Request("https://studio.example.test/api/jobs/" + created.job.id, {
        headers: { Cookie: cookie },
      }),
      testEnv()
    );
    expect(getResponse.status).toBe(200);
    const restored = await getResponse.json();
    expect(restored.job.id).toBe(created.job.id);
    expect(restored.job.input).toMatchObject({
      prompt: "A cinematic sunrise over an Egyptian village",
      durationSeconds: 5,
      aspectRatio: "16:9",
      visualStyle: "cinematic",
      quality: "768p",
    });
  });
});
