import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChildSpawnOptions } from "../src/manager.ts";
import { SUPERVISOR_FD_ENV, SUPERVISOR_STDIO_SLOT } from "../src/supervisor-watchdog.ts";

const children: ChildProcess[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const child of children.splice(0)) child.kill("SIGKILL");
});

const watchogModulePath = decodeURIComponent(new URL("../src/supervisor-watchdog.ts", import.meta.url).pathname);

/**
 * Spawn a real node child whose fd 3 is the read end of a supervisor pipe held
 * open by this (parent) process; the child script runs with `import()` of the
 * watchdog module available via WATCHDOG_MODULE.
 */
function spawnWatchdogChild(script: string): ChildProcess {
	const child = spawn(process.execPath, ["-e", script], {
		env: { ...process.env, PI_FD: "3", WATCHDOG_MODULE: watchogModulePath },
		stdio: ["ignore", "pipe", "inherit", "pipe"],
	});
	children.push(child);
	return child;
}

/** Wait for the first line of stdout, with a timeout so failures are diagnostics, not hangs. */
function readLine(child: ChildProcess, timeoutMs = 5000): Promise<string> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out waiting for child output")), timeoutMs);
		const onChunk = (chunk: Buffer) => {
			const line = chunk.toString("utf8").split("\n", 1)[0];
			if (line === undefined || line === "") return;
			clearTimeout(timer);
			child.stdout?.off("data", onChunk);
			resolve(line);
		};
		child.stdout?.on("data", onChunk);
	});
}

describe("supervisor watchdog", () => {
	it("detects parent pipe closure sub-second in a real child process and fires exactly once", async () => {
		const script = `
const { startSupervisorWatchdog } = await import(process.env.WATCHDOG_MODULE);
const startedAt = Date.now();
let calls = 0;
startSupervisorWatchdog(Number(process.env.PI_FD), () => {
	calls++;
	console.log(JSON.stringify({ event: "parent-death", calls, elapsedMs: Date.now() - startedAt }));
	process.exit(0);
});
console.log(JSON.stringify({ event: "ready" }));
setInterval(() => {}, 1000); // keep the event loop alive until EOF arrives
`;
		const child = spawnWatchdogChild(script);
		const ready = await readLine(child);
		expect(JSON.parse(ready)).toMatchObject({ event: "ready" });

		const start = Date.now();
		// The parent dies: the kernel closes its end. Locally we destroy it, which
		// is exactly the fd state the child observes after a parent crash.
		child.stdio[SUPERVISOR_STDIO_SLOT]?.destroy();
		const death = JSON.parse(await readLine(child)) as { event: string; calls: number; elapsedMs: number };

		expect(death.event).toBe("parent-death");
		expect(death.calls).toBe(1); // fired exactly once despite 'end' + 'close' both firing
		expect(Date.now() - start).toBeLessThan(1000); // sub-second, event-driven
		expect(death.elapsedMs).toBeLessThan(1000);
	}, 15000);

	it("does not invoke the callback when the disposer runs while the parent is alive", async () => {
		const script = `
const { startSupervisorWatchdog } = await import(process.env.WATCHDOG_MODULE);
const stop = startSupervisorWatchdog(Number(process.env.PI_FD), () => {
	console.log(JSON.stringify({ event: "parent-death" }));
});
console.log(JSON.stringify({ event: "ready" }));
stop(); // normal teardown while the parent is still alive
// No timers: the process exits by itself, proving disposal released the handle.
`;
		const child = spawnWatchdogChild(script);
		const ready = JSON.parse(await readLine(child)) as { event: string };
		expect(ready.event).toBe("ready");
		const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			child.once("exit", (code, signal) => resolve({ code, signal }));
		});
		expect(exit.code).toBe(0); // clean exit; no 'parent-death' line ever printed
		expect(exit.signal).toBeNull();
	}, 15000);

	it("schedules a pipe in the fourth stdio slot and injects the supervisor fd env", () => {
		const options = buildChildSpawnOptions({ PATH: "/usr/bin", EXISTING: "yes" }, "/tmp/run", SUPERVISOR_STDIO_SLOT);
		expect(options.stdio).toEqual(["ignore", "pipe", "pipe", "pipe"]);
		expect(options.shell).toBe(false);
		expect(options.cwd).toBe("/tmp/run");
		expect(options.env?.[SUPERVISOR_FD_ENV]).toBe(String(SUPERVISOR_STDIO_SLOT));
		expect(options.env?.EXISTING).toBe("yes");
	});
});
