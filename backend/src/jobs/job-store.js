import { DurableObject } from "cloudflare:workers";

const TRANSITIONS = Object.freeze({
  draft: ["queued", "cancelled"],
  queued: ["processing", "failed", "cancelled"],
  processing: ["completed", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
});

export class JobStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Prevent requests from observing a partially initialized or migrated schema.
    this.ready = this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          owner_id TEXT,
          status TEXT NOT NULL,
          provider_id TEXT,
          provider_job_id TEXT,
          input_json TEXT NOT NULL,
          output_json TEXT,
          error_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      const columns = this.ctx.storage.sql.exec("PRAGMA table_info(jobs)").toArray();
      if (!columns.some((column) => column.name === "owner_id")) {
        this.ctx.storage.sql.exec("ALTER TABLE jobs ADD COLUMN owner_id TEXT");
      }
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS job_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL,
          from_status TEXT,
          to_status TEXT NOT NULL,
          detail_json TEXT,
          created_at TEXT NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_jobs_owner_created ON jobs(owner_id, created_at DESC)"
      );
      this.ctx.storage.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events(job_id, event_id)"
      );
    });
  }

  createJob(record) {
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO jobs
         (id, owner_id, status, provider_id, provider_job_id, input_json, output_json, error_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        record.id, record.ownerId || null, record.status, record.providerId, record.providerJobId,
        JSON.stringify(record.input), null, null, now, now
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO job_events (job_id, from_status, to_status, detail_json, created_at) VALUES (?, ?, ?, ?, ?)",
        record.id, null, record.status, JSON.stringify({ note: "Draft saved; no generation started." }), now
      );
    });
    return this.getJob(record.id);
  }

  getJob(id) {
    const row = this.ctx.storage.sql.exec("SELECT * FROM jobs WHERE id = ?", id).toArray()[0];
    if (!row) return null;
    const events = this.ctx.storage.sql.exec(
      "SELECT from_status, to_status, detail_json, created_at FROM job_events WHERE job_id = ? ORDER BY event_id ASC",
      id
    ).toArray();
    return {
      id: row.id,
      ownerId: row.owner_id,
      status: row.status,
      providerId: row.provider_id,
      providerJobId: row.provider_job_id,
      input: JSON.parse(row.input_json),
      output: row.output_json ? JSON.parse(row.output_json) : null,
      error: row.error_json ? JSON.parse(row.error_json) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      events: events.map((event) => ({
        from: event.from_status,
        to: event.to_status,
        detail: event.detail_json ? JSON.parse(event.detail_json) : null,
        at: event.created_at,
      })),
    };
  }

  transitionJob(id, nextStatus, detail = {}) {
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      // Read and validate inside the transaction so status and event cannot diverge.
      const row = this.ctx.storage.sql.exec(
        "SELECT status, output_json, error_json FROM jobs WHERE id = ?", id
      ).toArray()[0];
      if (!row) throw new Error("JOB_NOT_FOUND");
      if (!TRANSITIONS[row.status]?.includes(nextStatus)) {
        throw new Error("INVALID_STATUS_TRANSITION");
      }
      const output = nextStatus === "completed" && detail.output
        ? detail.output
        : (row.output_json ? JSON.parse(row.output_json) : null);
      const error = nextStatus === "failed"
        ? (detail.error || { message: "Provider job failed." })
        : (row.error_json ? JSON.parse(row.error_json) : null);
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET status = ?, output_json = ?, error_json = ?, updated_at = ? WHERE id = ?",
        nextStatus, output ? JSON.stringify(output) : null,
        error ? JSON.stringify(error) : null, now, id
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO job_events (job_id, from_status, to_status, detail_json, created_at) VALUES (?, ?, ?, ?, ?)",
        id, row.status, nextStatus, JSON.stringify(detail), now
      );
    });
    return this.getJob(id);
  }
}
