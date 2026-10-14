// Local fork — the runner's native-TUI branch (`pi-runner --tui`).
//
// Instead of hosting `pi --mode rpc` behind a pane mirror, the runner hands
// the pane's terminal to the stock Pi TUI and loads the OpenRig extension
// (pi-openrig-extension.ts), which writes the sidecar and posts identity +
// activity. The runner keeps what only it can do: the launch-scoped pending
// sidecar, the deny-by-default child env, and an honest exit record.

import fs from "node:fs";
import nodePath from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareRunnerSidecar, resolveActivityEndpoint, type RunnerArgs } from "./pi-runner.js";
import {
  piSeatPaths, buildPiChildArgs, buildPiChildEnv, parsePiRunnerState,
  PI_RUNNER_EXIT_MARKER, PI_RUNNER_ERROR_MARKER, type PiRunnerState,
} from "./pi-runner-protocol.js";
import { PI_TUI_CONTROL_ENV, type PiTuiControl } from "./pi-openrig-extension.js";

/** RPC child argv → TUI child argv: drop `--mode rpc`, load the extension. */
export function buildPiTuiChildArgs(rpcArgs: string[], extensionPath: string): string[] {
  const args: string[] = [];
  for (let i = 0; i < rpcArgs.length; i++) {
    if (rpcArgs[i] === "--mode" && rpcArgs[i + 1] === "rpc") { i++; continue; }
    args.push(rpcArgs[i]!);
  }
  return ["--extension", extensionPath, ...args];
}

/** The exit record for this launch. Unlike a fresh pending record it keeps
 *  the session identity the extension published, so the resume token and
 *  catch-up cursor survive the exit. */
export function piTuiExitState(currentRaw: string | null, launchId: string, code: number | null, at: string): PiRunnerState {
  const current = currentRaw ? parsePiRunnerState(currentRaw) : null;
  const same = current?.launchId === launchId ? current : null;
  return {
    ready: false,
    launchId,
    sessionFile: same?.sessionFile,
    sessionId: same?.sessionId,
    lastEntryId: current?.lastEntryId,
    updatedAt: at,
    exited: { code, at },
  };
}

export async function runPiTui(args: RunnerArgs): Promise<void> {
  const paths = piSeatPaths(args.stateRoot, args.sessionName);
  fs.mkdirSync(paths.agentDir, { recursive: true });
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  const now = () => new Date().toISOString();

  prepareRunnerSidecar(
    {
      readFile: (p) => fs.readFileSync(p, "utf8"),
      writeFile: (p, c) => fs.writeFileSync(p, c),
      exists: (p) => fs.existsSync(p),
    },
    paths.runnerStatePath,
    args.launchId,
    !!args.sessionFile,
    now,
  );

  const endpoint = resolveActivityEndpoint(process.env);
  const control: PiTuiControl = {
    sessionName: args.sessionName,
    nodeId: process.env.OPENRIG_NODE_ID ?? null,
    generation: process.env.OPENRIG_OCCUPANT_GENERATION ?? null,
    launchId: args.launchId,
    runnerStatePath: paths.runnerStatePath,
    endpoint,
  };
  const controlPath = nodePath.join(paths.seatRoot, "tui-control.json");
  fs.writeFileSync(controlPath, JSON.stringify(control), { mode: 0o600 });
  fs.chmodSync(controlPath, 0o600);

  const childEnv = buildPiChildEnv(process.env as Record<string, string | undefined>, {
    agentDir: paths.agentDir,
    sessionsDir: paths.sessionsDir,
    model: args.model,
    runtime: "pi",
    sessionName: args.sessionName,
    nodeId: process.env.OPENRIG_NODE_ID,
    openrigHome: process.env.OPENRIG_HOME,
    openrigUrl: endpoint?.baseUrl ?? process.env.OPENRIG_URL,
  });
  childEnv[PI_TUI_CONTROL_ENV] = controlPath;

  const extensionPath = fileURLToPath(new URL("./pi-openrig-extension.js", import.meta.url));
  const childArgs = buildPiTuiChildArgs(buildPiChildArgs({
    sessionsDir: paths.sessionsDir,
    sessionName: args.sessionName,
    model: args.model,
    trust: args.trust,
    sessionFile: args.sessionFile,
    forkRef: args.forkRef,
  }), extensionPath);

  // Ctrl-C belongs to Pi (it runs the terminal in raw mode); never let a
  // stray SIGINT kill the runner out from under it.
  const ignoreInt = () => {};
  const forward = (signal: NodeJS.Signals) => () => { child.kill(signal); };
  process.on("SIGINT", ignoreInt);

  const child = spawn("pi", childArgs, { cwd: args.cwd, env: childEnv, stdio: "inherit" });
  const onTerm = forward("SIGTERM");
  const onHup = forward("SIGHUP");
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onHup);

  let exited = false;
  const recordExit = (code: number | null): void => {
    if (exited) return;
    exited = true;
    process.removeListener("SIGINT", ignoreInt);
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGHUP", onHup);
    let currentRaw: string | null = null;
    try { currentRaw = fs.readFileSync(paths.runnerStatePath, "utf8"); } catch { /* absent */ }
    try {
      fs.writeFileSync(paths.runnerStatePath, JSON.stringify(piTuiExitState(currentRaw, args.launchId, code, now())));
    } catch { /* the pane marker + shell foreground still fail readiness */ }
    process.stdout.write(`\n${PI_RUNNER_EXIT_MARKER} pi exited (code ${code ?? "unknown"})\n`);
    if (endpoint && typeof fetch === "function") {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      fetch(new URL("/api/activity/hooks", endpoint.baseUrl).toString(), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify({
          sessionName: args.sessionName, nodeId: control.nodeId, generation: control.generation,
          runtime: "pi", hookEvent: "Stop", subtype: "pi_exited", occurredAt: now(),
        }),
        signal: controller.signal,
      }).catch(() => { /* best-effort */ }).finally(() => clearTimeout(timeout));
    }
    process.exitCode = code ?? 1;
  };

  child.on("error", (err) => {
    console.error(`${PI_RUNNER_ERROR_MARKER} failed to spawn pi: ${err.message}`);
    recordExit((err as NodeJS.ErrnoException).code === "ENOENT" ? 127 : 1);
  });
  child.on("exit", (code) => recordExit(code));
}
