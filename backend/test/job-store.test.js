import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

function uniqueStore() {
  const id = env.JOB_STORE.newUniqueId();
  return env.JOB_STORE.get(id);
}

function draft(id, ownerId = "user-a") {
  return {
    id,
    ownerId,
    status: "draft",
    providerId: null,
    providerJobId: null,
    input: {
      prompt: "A calm cinematic sunrise",
      durationSeconds: 5,
      aspectRatio: "16:9",
      visualStyle: "cinematic",
      quality: "480p",
    },
  };
}

describe("JobStore Durable Object", () => {
  it("creates a draft and its initial event together", async () => {
    const store = uniqueStore();
    const record = draft("job-create-1");
    const job = await store.createJob(record);

    expect(job.id).toBe(record.id);
    expect(job.ownerId).toBe("user-a");
    expect(job.status).toBe("draft");
    expect(job.events).toHaveLength(1);
    expect(job.events[0].from).toBeNull();
    expect(job.events[0].to).toBe("draft");
    expect(await store.getJob(record.id)).toEqual(job);
  });

  it("persists records across repeated stub calls", async () => {
    const store = uniqueStore();
    await store.createJob(draft("job-persist-1", "user-b"));

    const loaded = await store.getJob("job-persist-1");
    expect(loaded.ownerId).toBe("user-b");
    expect(loaded.events).toHaveLength(1);
  });

  it("updates status and appends its event as one lifecycle operation", async () => {
    const store = uniqueStore();
    await store.createJob(draft("job-transition-1"));

    const queued = await store.transitionJob("job-transition-1", "queued", { source: "test" });
    expect(queued.status).toBe("queued");
    expect(queued.events).toHaveLength(2);
    expect(queued.events[1]).toMatchObject({ from: "draft", to: "queued", detail: { source: "test" } });
  });

  it("rolls back a status update if event serialization fails", async () => {
    const store = uniqueStore();
    await store.createJob(draft("job-rollback-1"));
    const circular = {};
    circular.self = circular;

    await expect(store.transitionJob("job-rollback-1", "queued", circular)).rejects.toThrow();
    const unchanged = await store.getJob("job-rollback-1");
    expect(unchanged.status).toBe("draft");
    expect(unchanged.events).toHaveLength(1);
  });

  it("rejects invalid transitions without changing the job or event history", async () => {
    const store = uniqueStore();
    await store.createJob(draft("job-invalid-1"));

    await expect(store.transitionJob("job-invalid-1", "completed")).rejects.toThrow("INVALID_STATUS_TRANSITION");
    const unchanged = await store.getJob("job-invalid-1");
    expect(unchanged.status).toBe("draft");
    expect(unchanged.events).toHaveLength(1);
  });

  it("keeps jobs isolated by Durable Object identity", async () => {
    const first = uniqueStore();
    const second = uniqueStore();
    await first.createJob(draft("job-isolated-1"));

    expect(await second.getJob("job-isolated-1")).toBeNull();
  });

  it("returns null for an unknown job", async () => {
    const store = uniqueStore();
    expect(await store.getJob("missing-job")).toBeNull();
  });
});
