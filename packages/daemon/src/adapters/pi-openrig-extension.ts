// Local fork — the OpenRig Pi extension for native-TUI Pi seats.
//
// pi-tui-launch.ts starts the stock `pi` TUI with `--extension <this file>`.
// The extension takes over what the RPC runner's RunnerCore does for the
// daemon: it writes the launch-scoped runner-state.json sidecar (readiness,
// resume token) and posts session identity + activity to the daemon's
// activity endpoint, using the same payload shapes. Everything else (pane
// delivery, readiness, resume) stays on the existing Pi adapter paths.
//
// Dependency-free on purpose (node builtins only, untyped Pi API) so Pi can
// load the compiled file from the daemon dist without OpenRig's modules.

import fs from "node:fs";

export const PI_TUI_CONTROL_ENV = "OPENRIG_PI_TUI_CONTROL";

/** Written by pi-tui-launch.ts (mode 0600) before Pi starts. */
export interface PiTuiControl {
  sessionName: string;
  nodeId: string | null;
  generation: string | null;
  launchId: string;
  runnerStatePath: string;
  endpoint: { baseUrl: string; token: string } | null;
}

export interface PiTuiBridgeIo {
  readFile(path: string): string | null;
  writeFile(path: string, content: string): void;
  /** Fire-and-forget POST of a JSON payload to a daemon path. */
  post(path: string, payload: Record<string, unknown>): void;
  now(): string;
}

export function parsePiTuiControl(raw: string | null): PiTuiControl | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PiTuiControl>;
    if (typeof parsed.sessionName !== "string" || typeof parsed.launchId !== "string"
      || typeof parsed.runnerStatePath !== "string") return null;
    return {
      sessionName: parsed.sessionName,
      nodeId: typeof parsed.nodeId === "string" ? parsed.nodeId : null,
      generation: typeof parsed.generation === "string" ? parsed.generation : null,
      launchId: parsed.launchId,
      runnerStatePath: parsed.runnerStatePath,
      endpoint: parsed.endpoint && typeof parsed.endpoint.baseUrl === "string" && typeof parsed.endpoint.token === "string"
        ? { baseUrl: parsed.endpoint.baseUrl, token: parsed.endpoint.token } : null,
    };
  } catch {
    return null;
  }
}

export function createPiTuiBridge(control: PiTuiControl, io: PiTuiBridgeIo) {
  const priorLastEntryId = (): string | undefined => {
    try {
      const prior = JSON.parse(io.readFile(control.runnerStatePath) ?? "null") as { lastEntryId?: unknown } | null;
      return typeof prior?.lastEntryId === "string" ? prior.lastEntryId : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    /** Every session_start (startup, resume, fork, /new, …) re-publishes the
     *  current session file — the sidecar and the daemon's resume token follow
     *  whatever session the TUI is on. */
    sessionStart(sessionFile: string | undefined, sessionId: string | undefined): void {
      const now = io.now();
      try {
        io.writeFile(control.runnerStatePath, JSON.stringify({
          ready: true,
          launchId: control.launchId,
          sessionFile,
          sessionId,
          lastEntryId: priorLastEntryId(),
          updatedAt: now,
        }));
      } catch { /* the adapter times out honestly without a ready sidecar */ }
      io.post("/api/activity/hooks", {
        eventFamily: "session_identity",
        sessionName: control.sessionName,
        nodeId: control.nodeId,
        runtime: "pi",
        generation: control.generation,
        hookEvent: "SessionStart",
        sessionId: sessionId ?? "unknown",
        sessionFile: sessionFile ?? null,
        occurredAt: now,
      });
    },

    activity(hookEvent: string, subtype: string | null): void {
      io.post("/api/activity/hooks", {
        sessionName: control.sessionName,
        nodeId: control.nodeId,
        generation: control.generation,
        runtime: "pi",
        hookEvent,
        subtype,
        occurredAt: io.now(),
      });
    },
  };
}

function nodeIo(control: PiTuiControl): PiTuiBridgeIo {
  return {
    readFile: (path) => {
      try { return fs.readFileSync(path, "utf8"); } catch { return null; }
    },
    writeFile: (path, content) => fs.writeFileSync(path, content),
    post: (path, payload) => {
      const endpoint = control.endpoint;
      if (!endpoint || typeof fetch !== "function") return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      fetch(new URL(path, endpoint.baseUrl).toString(), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).catch(() => { /* best-effort — never blocks Pi */ }).finally(() => clearTimeout(timeout));
    },
    now: () => new Date().toISOString(),
  };
}

// Pi's ExtensionAPI is not a dependency of the daemon, so it stays untyped here.
export default function openrigPiExtension(pi: any): void {
  const controlPath = process.env[PI_TUI_CONTROL_ENV];
  // Outside an OpenRig TUI seat this extension does nothing.
  if (!controlPath) return;
  // Keep the locator out of the environment Pi's tools inherit.
  delete process.env[PI_TUI_CONTROL_ENV];
  let raw: string | null = null;
  try { raw = fs.readFileSync(controlPath, "utf8"); } catch { /* unreadable → inert */ }
  const control = parsePiTuiControl(raw);
  if (!control) return;
  const bridge = createPiTuiBridge(control, nodeIo(control));

  pi.on("session_start", (_event: any, ctx: any) => {
    bridge.sessionStart(ctx.sessionManager?.getSessionFile?.(), ctx.sessionManager?.getSessionId?.());
    if (ctx.hasUI) ctx.ui?.setStatus?.("openrig", `openrig: ${control.sessionName}`);
  });
  pi.on("agent_start", () => bridge.activity("active", "agent_start"));
  pi.on("tool_execution_start", (event: any) => {
    bridge.activity("PreToolUse", typeof event?.toolName === "string" ? event.toolName : "tool");
  });
  pi.on("agent_end", () => bridge.activity("Stop", "agent_end"));
  pi.on("session_before_compact", () => { bridge.activity("active", "compaction"); });
}
