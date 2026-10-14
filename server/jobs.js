// In-memory background jobs with streaming logs, plus a promise-based
// process runner that pipes child output into the job log.
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const jobs = new Map();

export function createJob(kind, ref, fn) {
  const job = {
    id: crypto.randomUUID(),
    kind,
    ref, // e.g. { videoId } or { clipId }
    status: "running",
    log: [],
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  const log = (line) => {
    for (const l of String(line).split(/\r?\n|\r/)) {
      if (l.trim()) job.log.push(l);
    }
    if (job.log.length > 2000) job.log.splice(0, job.log.length - 2000);
  };
  Promise.resolve()
    .then(() => fn(log, job))
    .then(() => {
      job.status = "done";
    })
    .catch((err) => {
      job.status = "error";
      job.error = err?.message || String(err);
      log(`ERROR: ${job.error}`);
    })
    .finally(() => {
      job.finishedAt = Date.now();
    });
  return job;
}

export function getJob(id) {
  return jobs.get(id);
}

export function activeJob(kind, match) {
  for (const j of jobs.values()) {
    if (j.kind === kind && j.status === "running" && match(j.ref)) return j;
  }
  return null;
}

export function listJobs(match = () => true) {
  return [...jobs.values()].filter((j) => match(j)).map(summary);
}

export function summary(j) {
  return {
    id: j.id,
    kind: j.kind,
    ref: j.ref,
    status: j.status,
    error: j.error,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    tail: j.log.slice(-40),
  };
}

/**
 * Run a command, resolving with { stdout, stderr }. Rejects on non-zero exit.
 * Pass `log` to stream output lines into a job log.
 */
export function run(cmd, args, { cwd, log, input, env, captureStdout = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      if (captureStdout) stdout += d;
      log?.(d.toString());
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      log?.(d.toString());
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = (stderr || stdout).trim().split("\n").slice(-8).join("\n");
        reject(new Error(`${cmd} exited with code ${code}\n${tail}`));
      }
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}
