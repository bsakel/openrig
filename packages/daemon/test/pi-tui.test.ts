// Local fork — native-TUI Pi seats: the --tui launch switch, the TUI child
// argv, the exit record, and the OpenRig Pi extension's sidecar + activity
// bridge. No live pi.

import { afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { parseRunnerArgs } from "../src/adapters/pi-runner.js";
import { buildPiChildArgs, buildPiRunnerCommand, parsePiRunnerState } from "../src/adapters/pi-runner-protocol.js";
import { buildPiTuiChildArgs, piTuiExitState } from "../src/adapters/pi-tui-launch.js";
import openrigPiExtension, {
  createPiTuiBridge, parsePiTuiControl, PI_TUI_CONTROL_ENV, type PiTuiControl,
} from "../src/adapters/pi-openrig-extension.js";

const SESSION = "devpi-a@some-rig";
const SESSION_FILE = "/state/pi/devpi-a@some-rig/sessions/2026_0197.jsonl";
const STATE_PATH = "/state/pi/devpi-a@some-rig/runner-state.json";
const NOW = "2026-10-14T12:00:00.000Z";

const base = {
  runnerEntryPath: "/dist/adapters/pi-runner.js",
  sessionName: SESSION,
  stateRoot: "/state/pi",
  cwd: "/work",
  trust: "no-approve" as const,
  launchId: "launch-1",
};

afterEach(() => { vi.unstubAllEnvs(); });

describe("--tui launch switch", () => {
  it("is off by default and byte-identical to the RPC command", () => {
    vi.stubEnv("OPENRIG_PI_TUI", "");
    expect(buildPiRunnerCommand(base)).not.toContain("--tui");
  });

  it("follows OPENRIG_PI_TUI=1 for Pi, and an explicit opt overrides it", () => {
    vi.stubEnv("OPENRIG_PI_TUI", "1");
    expect(buildPiRunnerCommand(base)).toBe(`${buildPiRunnerCommand({ ...base, tui: false })} --tui`);
    vi.stubEnv("OPENRIG_PI_TUI", "");
    expect(buildPiRunnerCommand({ ...base, tui: true }).endsWith(" --tui")).toBe(true);
  });

  it("never applies to OMP", () => {
    vi.stubEnv("OPENRIG_PI_TUI", "1");
    expect(buildPiRunnerCommand({ ...base, runtime: "omp", tui: true })).not.toContain("--tui");
  });

  it("parses --tui for Pi and refuses it for OMP", () => {
    const argv = ["--session-name", SESSION, "--state-root", "/sr", "--cwd", "/w", "--launch-id", "L"];
    expect(parseRunnerArgs([...argv, "--no-approve", "--tui"]).tui).toBe(true);
    expect(parseRunnerArgs([...argv, "--no-approve"]).tui).toBeUndefined();
    expect(() => parseRunnerArgs([...argv, "--runtime", "omp", "--approval-mode", "yolo", "--tui"])).toThrow(/Pi only/);
  });
});

describe("buildPiTuiChildArgs", () => {
  it("drops --mode rpc, loads the extension, and keeps the managed flags", () => {
    const rpc = buildPiChildArgs({ sessionsDir: "/s", sessionName: SESSION, model: "zai/glm", trust: "no-approve", sessionFile: SESSION_FILE });
    const tui = buildPiTuiChildArgs(rpc, "/dist/adapters/pi-openrig-extension.js");
    expect(tui).not.toContain("rpc");
    expect(tui).not.toContain("--mode");
    expect(tui.slice(0, 2)).toEqual(["--extension", "/dist/adapters/pi-openrig-extension.js"]);
    expect(tui).toEqual(expect.arrayContaining(["--session-dir", "/s", "--name", SESSION, "--no-approve", "--model", "zai/glm", "--session", SESSION_FILE]));
  });
});

describe("piTuiExitState", () => {
  it("keeps the identity this launch published", () => {
    const current = JSON.stringify({ ready: true, launchId: "launch-1", sessionFile: SESSION_FILE, sessionId: "sid", lastEntryId: "e9", updatedAt: NOW });
    const state = piTuiExitState(current, "launch-1", 0, NOW);
    expect(state).toEqual({ ready: false, launchId: "launch-1", sessionFile: SESSION_FILE, sessionId: "sid", lastEntryId: "e9", updatedAt: NOW, exited: { code: 0, at: NOW } });
    expect(parsePiRunnerState(JSON.stringify(state))).not.toBeNull();
  });

  it("never carries another launch's identity, only the cursor", () => {
    const stale = JSON.stringify({ ready: true, launchId: "old", sessionFile: "/old.jsonl", lastEntryId: "e1", updatedAt: NOW });
    const state = piTuiExitState(stale, "launch-1", 1, NOW);
    expect(state.sessionFile).toBeUndefined();
    expect(state.lastEntryId).toBe("e1");
    expect(piTuiExitState(null, "launch-1", null, NOW).exited).toEqual({ code: null, at: NOW });
  });
});

const control: PiTuiControl = {
  sessionName: SESSION, nodeId: "node-1", generation: "gen-1", launchId: "launch-1",
  runnerStatePath: STATE_PATH, endpoint: { baseUrl: "http://127.0.0.1:7433", token: "t" },
};

function fakeBridgeIo(prior: string | null = null) {
  const files = new Map<string, string>();
  if (prior !== null) files.set(STATE_PATH, prior);
  const posts: Array<{ path: string; payload: Record<string, unknown> }> = [];
  return {
    files, posts,
    io: {
      readFile: (p: string) => files.get(p) ?? null,
      writeFile: (p: string, c: string) => { files.set(p, c); },
      exists: (p: string) => files.has(p),
      post: (path: string, payload: Record<string, unknown>) => { posts.push({ path, payload }); },
      now: () => NOW,
    },
  };
}

describe("createPiTuiBridge", () => {
  it("publishes a ready, launch-scoped sidecar and the session identity", () => {
    const fake = fakeBridgeIo(JSON.stringify({ ready: false, launchId: "launch-1", lastEntryId: "e7", updatedAt: NOW }));
    createPiTuiBridge(control, fake.io).sessionStart(SESSION_FILE, "sid");
    expect(JSON.parse(fake.files.get(STATE_PATH)!)).toEqual({
      ready: true, launchId: "launch-1", sessionFile: SESSION_FILE, sessionId: "sid", lastEntryId: "e7", updatedAt: NOW,
    });
    expect(fake.posts).toEqual([{ path: "/api/activity/hooks", payload: {
      eventFamily: "session_identity", sessionName: SESSION, nodeId: "node-1", runtime: "pi", generation: "gen-1",
      hookEvent: "SessionStart", sessionId: "sid", sessionFile: SESSION_FILE, occurredAt: NOW,
    } }]);
  });

  it("publishes the launch's first session at once, even before Pi writes its file", () => {
    const fake = fakeBridgeIo();
    createPiTuiBridge(control, fake.io).sessionStart(SESSION_FILE, "sid");
    expect(JSON.parse(fake.files.get(STATE_PATH)!).sessionFile).toBe(SESSION_FILE);
    expect(fake.posts).toHaveLength(1);
  });

  it("holds a /new switch until Pi has written the new file, then publishes it after a turn", () => {
    const fake = fakeBridgeIo();
    fake.files.set(SESSION_FILE, "{}");
    const bridge = createPiTuiBridge(control, fake.io);
    bridge.sessionStart(SESSION_FILE, "sid");
    const next = SESSION_FILE.replace("0197", "0198");
    bridge.sessionStart(next, "sid-2");
    bridge.flushPending();
    expect(JSON.parse(fake.files.get(STATE_PATH)!).sessionFile).toBe(SESSION_FILE);
    expect(fake.posts).toHaveLength(1);
    fake.files.set(next, "{}");
    bridge.flushPending();
    expect(JSON.parse(fake.files.get(STATE_PATH)!)).toMatchObject({ sessionFile: next, sessionId: "sid-2" });
    expect(fake.posts.at(-1)!.payload).toMatchObject({ eventFamily: "session_identity", sessionFile: next, sessionId: "sid-2" });
    bridge.flushPending();
    expect(fake.posts).toHaveLength(2);
  });

  it("publishes a switch to an existing session immediately, dropping a stale pending one", () => {
    const fake = fakeBridgeIo();
    const resumed = "/state/pi/devpi-a@some-rig/sessions/older.jsonl";
    fake.files.set(SESSION_FILE, "{}");
    fake.files.set(resumed, "{}");
    const bridge = createPiTuiBridge(control, fake.io);
    bridge.sessionStart(SESSION_FILE, "sid");
    bridge.sessionStart("/state/pi/devpi-a@some-rig/sessions/new.jsonl", "sid-new");
    bridge.sessionStart(resumed, "sid-old");
    expect(JSON.parse(fake.files.get(STATE_PATH)!).sessionFile).toBe(resumed);
    fake.files.set("/state/pi/devpi-a@some-rig/sessions/new.jsonl", "{}");
    bridge.flushPending();
    expect(JSON.parse(fake.files.get(STATE_PATH)!).sessionFile).toBe(resumed);
  });

  it("posts activity in the runner's payload shape", () => {
    const fake = fakeBridgeIo();
    createPiTuiBridge(control, fake.io).activity("PreToolUse", "bash");
    expect(fake.posts[0]!.payload).toEqual({
      sessionName: SESSION, nodeId: "node-1", generation: "gen-1", runtime: "pi", hookEvent: "PreToolUse", subtype: "bash", occurredAt: NOW,
    });
  });
});

describe("parsePiTuiControl", () => {
  it("accepts a complete control file and rejects junk", () => {
    expect(parsePiTuiControl(JSON.stringify(control))).toEqual(control);
    expect(parsePiTuiControl(JSON.stringify({ ...control, endpoint: { baseUrl: 1 } }))!.endpoint).toBeNull();
    expect(parsePiTuiControl("{")).toBeNull();
    expect(parsePiTuiControl(JSON.stringify({ sessionName: SESSION }))).toBeNull();
    expect(parsePiTuiControl(null)).toBeNull();
  });
});

describe("openrigPiExtension", () => {
  const SLOT = Symbol.for("openrig.pi-tui.bridge");
  afterEach(() => { delete (globalThis as Record<symbol, unknown>)[SLOT]; });

  it("is inert outside an OpenRig TUI seat", () => {
    vi.stubEnv(PI_TUI_CONTROL_ENV, "");
    const pi = { on: vi.fn() };
    openrigPiExtension(pi);
    expect(pi.on).not.toHaveBeenCalled();
  });

  it("stays active when Pi re-runs the factory after a session replacement", () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "pi-tui-"));
    try {
      const controlPath = nodePath.join(dir, "tui-control.json");
      fs.writeFileSync(controlPath, JSON.stringify({ ...control, endpoint: null, runnerStatePath: nodePath.join(dir, "runner-state.json") }));
      vi.stubEnv(PI_TUI_CONTROL_ENV, controlPath);
      const first = { on: vi.fn() };
      openrigPiExtension(first);
      // The locator leaves the environment Pi's tools inherit…
      expect(process.env[PI_TUI_CONTROL_ENV]).toBeUndefined();
      // …and a second factory run (Pi's /new runtime replacement) still binds.
      const second = { on: vi.fn() };
      openrigPiExtension(second);
      expect(second.on.mock.calls.map(([event]) => event)).toEqual(first.on.mock.calls.map(([event]) => event));
      expect(second.on.mock.calls.map(([event]) => event)).toContain("session_start");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
