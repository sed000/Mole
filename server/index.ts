import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";

const ROOT_DIR = resolve(import.meta.dir, "..");
const BIN_DIR = resolve(ROOT_DIR, "bin");
const WEB_DIR = resolve(ROOT_DIR, "web");
const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.MOLE_API_PORT ?? "8787", 10);

const jobs = new Map<string, Job>();

type JobStatus = "queued" | "running" | "waiting_sudo" | "completed" | "failed";

type Job = {
  id: string;
  status: JobStatus;
  command: string;
  args: string[];
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number | null;
  summary?: Record<string, unknown>;
  logs: string[];
  sse?: Set<ReadableStreamDefaultController>;
  env?: Record<string, string>;
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type JsonBody = Record<string, JsonValue>;

const MIME_JSON = "application/json";
const MIME_SSE = "text/event-stream";

const binPath = (name: string) => resolve(BIN_DIR, `${name}.sh`);

const webAsset = (path: string) => resolve(WEB_DIR, "dist", path);

const fileExists = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const json = (status: number, data: JsonBody) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": MIME_JSON,
      "access-control-allow-origin": "*",
    },
  });

const notFound = () => json(404, { error: "not_found" });

const badRequest = (message: string) => json(400, { error: message });

const ok = (data: JsonBody = {}) => json(200, data);

const parseBody = async (request: Request) => {
  if (request.body === null) {
    return {} as JsonBody;
  }

  try {
    const body = (await request.json()) as JsonBody;
    return body ?? {};
  } catch {
    return null;
  }
};

const listJobs = () =>
  Array.from(jobs.values()).map((job) => ({
    id: job.id,
    status: job.status,
    command: job.command,
    args: job.args,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    summary: job.summary ?? null,
  }));

const enqueueJob = (command: string, args: string[], env?: Record<string, string>) => {
  const id = randomUUID();
  const job: Job = {
    id,
    status: "queued",
    command,
    args,
    createdAt: Date.now(),
    logs: [],
    env,
    sse: new Set(),
  };

  jobs.set(id, job);
  runJob(job);
  return job;
};

const writeLog = (job: Job, line: string) => {
  job.logs.push(line);
  if (job.logs.length > 400) {
    job.logs.shift();
  }

  if (job.sse) {
    for (const controller of job.sse) {
      controller.enqueue(`data: ${JSON.stringify({ line })}\n\n`);
    }
  }
};

const runJob = (job: Job) => {
  job.status = "running";
  job.startedAt = Date.now();

  const child = spawn(job.command, job.args, {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      MOLE_NO_COLOR: "1",
      ...(job.env ?? {}),
    },
  });

  child.stdout.on("data", (chunk) => {
    const lines = chunk.toString().split(/\r?\n/);
    for (const line of lines) {
      if (line.trim().length > 0) {
        writeLog(job, line);
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    const lines = chunk.toString().split(/\r?\n/);
    for (const line of lines) {
      if (line.trim().length > 0) {
        writeLog(job, line);
      }
    }
  });

  child.on("close", (code) => {
    job.exitCode = code;
    job.finishedAt = Date.now();
    job.status = code === 0 ? "completed" : "failed";
    if (job.sse) {
      for (const controller of job.sse) {
        controller.enqueue(`event: done\ndata: ${JSON.stringify({ exitCode: code })}\n\n`);
      }
    }
  });
};

const handleSse = (job: Job) => {
  let controllerRef: ReadableStreamDefaultController | null = null;
  const stream = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      if (!job.sse) {
        job.sse = new Set();
      }
      job.sse.add(controller);
      controller.enqueue(`event: status\ndata: ${JSON.stringify({ status: job.status })}\n\n`);
      for (const line of job.logs) {
        controller.enqueue(`data: ${JSON.stringify({ line })}\n\n`);
      }
    },
    cancel() {
      if (job.sse && controllerRef) {
        job.sse.delete(controllerRef);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": MIME_SSE,
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    },
  });
};

const resolveAnalyzeCommand = () => {
  const analyzeBin = resolve(BIN_DIR, "analyze-go");
  if (fileExists(analyzeBin)) {
    return { command: analyzeBin, args: [] as string[] };
  }
  return { command: "go", args: ["run", "./cmd/analyze"] };
};

const resolveStatusCommand = () => {
  const statusBin = resolve(BIN_DIR, "status-go");
  if (fileExists(statusBin)) {
    return { command: statusBin, args: [] as string[] };
  }
  return { command: "go", args: ["run", "./cmd/status"] };
};

const serveStatic = async (request: Request) => {
  const url = new URL(request.url);
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  const assetPath = webAsset(path.slice(1));
  if (!assetPath.startsWith(resolve(WEB_DIR, "dist"))) {
    return notFound();
  }
  if (!fileExists(assetPath)) {
    return notFound();
  }
  return new Response(Bun.file(assetPath));
};

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  fetch: async (request) => {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    if (pathname === "/api/health") {
      return ok({ status: "ok" });
    }

    if (pathname === "/api/jobs" && request.method === "GET") {
      return ok({ jobs: listJobs() });
    }

    if (pathname.startsWith("/api/jobs/") && request.method === "GET") {
      const id = pathname.split("/")[3];
      const job = id ? jobs.get(id) : null;
      if (!job) {
        return notFound();
      }
      return ok({
        id: job.id,
        status: job.status,
        command: job.command,
        args: job.args,
        createdAt: job.createdAt,
        startedAt: job.startedAt ?? null,
        finishedAt: job.finishedAt ?? null,
        exitCode: job.exitCode ?? null,
        summary: job.summary ?? null,
      });
    }

    if (pathname.startsWith("/api/jobs/") && pathname.endsWith("/stream")) {
      const id = pathname.split("/")[3];
      const job = id ? jobs.get(id) : null;
      if (!job) {
        return notFound();
      }
      return handleSse(job);
    }

    if (pathname === "/api/clean" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) {
        return badRequest("invalid_json");
      }
      const system = body.system === true;
      const args = [binPath("clean"), "--non-interactive", "--json"];
      if (system) {
        args.push("--system");
      } else {
        args.push("--no-system");
      }
      const env: Record<string, string> = {};
      if (typeof body.sudoPassword === "string" && body.sudoPassword.length > 0) {
        env.MOLE_SUDO_PASSWORD = body.sudoPassword;
      }
      const job = enqueueJob(args[0], args.slice(1), env);
      return ok({ jobId: job.id });
    }

    if (pathname === "/api/optimize" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) {
        return badRequest("invalid_json");
      }
      const args = [binPath("optimize"), "--non-interactive"];
      if (body.dryRun === true) {
        args.push("--dry-run");
      }
      if (body.applySecurityFixes === true) {
        args.push("--apply-security-fixes");
      }
      if (body.applyUpdates === true) {
        args.push("--apply-updates");
      }
      if (body.applyAutoFix === true) {
        args.push("--apply-autofix");
      }
      const env: Record<string, string> = {};
      if (typeof body.sudoPassword === "string" && body.sudoPassword.length > 0) {
        env.MOLE_SUDO_PASSWORD = body.sudoPassword;
      }
      const job = enqueueJob(args[0], args.slice(1), env);
      return ok({ jobId: job.id });
    }

    if (pathname === "/api/uninstall/apps" && request.method === "GET") {
      const args = [binPath("uninstall"), "--list-json"];
      const job = enqueueJob(args[0], args.slice(1));
      return ok({ jobId: job.id });
    }

    if (pathname === "/api/uninstall" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body || !Array.isArray(body.apps)) {
        return badRequest("invalid_apps");
      }
      const args = [binPath("uninstall"), "--uninstall-json"];
      for (const app of body.apps) {
        if (typeof app === "string" && app.length > 0) {
          args.push(app);
        }
      }
      const env: Record<string, string> = {};
      if (typeof body.sudoPassword === "string" && body.sudoPassword.length > 0) {
        env.MOLE_SUDO_PASSWORD = body.sudoPassword;
      }
      const job = enqueueJob(args[0], args.slice(1), env);
      return ok({ jobId: job.id });
    }

    if (pathname === "/api/purge" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body || !Array.isArray(body.paths)) {
        return badRequest("invalid_paths");
      }
      const args = [binPath("purge"), "--json"];
      for (const item of body.paths) {
        if (typeof item === "string" && item.length > 0) {
          args.push("--path", item);
        }
      }
      const job = enqueueJob(args[0], args.slice(1));
      return ok({ jobId: job.id });
    }

    if (pathname === "/api/purge/targets" && request.method === "GET") {
      const args = [binPath("purge"), "--list-json"];
      const job = enqueueJob(args[0], args.slice(1));
      return ok({ jobId: job.id });
    }

    if (pathname === "/api/installers" && request.method === "GET") {
      const args = [binPath("installer"), "--json"];
      const job = enqueueJob(args[0], args.slice(1));
      return ok({ jobId: job.id });
    }

    if (pathname === "/api/installers" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body || !Array.isArray(body.paths)) {
        return badRequest("invalid_paths");
      }
      const args = [binPath("installer"), "--delete"];
      for (const item of body.paths) {
        if (typeof item === "string" && item.length > 0) {
          args.push(item);
        }
      }
      const job = enqueueJob(args[0], args.slice(1));
      return ok({ jobId: job.id });
    }

    if (pathname === "/api/analyze" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body) {
        return badRequest("invalid_json");
      }
      const path = typeof body.path === "string" ? body.path : "";
      const { command, args } = resolveAnalyzeCommand();
      const fullArgs = [...args, "--json"];
      if (path.length > 0) {
        fullArgs.push("--path", path);
      }
      const job = enqueueJob(command, fullArgs);
      return ok({ jobId: job.id });
    }

    if (pathname === "/api/analyze/delete" && request.method === "POST") {
      const body = await parseBody(request);
      if (!body || !Array.isArray(body.paths)) {
        return badRequest("invalid_paths");
      }
      const { command, args } = resolveAnalyzeCommand();
      const fullArgs = [...args, "--delete", ...body.paths.map(String)];
      const job = enqueueJob(command, fullArgs);
      return ok({ jobId: job.id });
    }

    if (pathname === "/api/status" && request.method === "POST") {
      const { command, args } = resolveStatusCommand();
      const job = enqueueJob(command, [...args, "--json", "--once"]);
      return ok({ jobId: job.id });
    }

    if (pathname.startsWith("/api/")) {
      return notFound();
    }

    return serveStatic(request);
  },
});

console.log(`Mole API running on http://${HOST}:${server.port}`);
