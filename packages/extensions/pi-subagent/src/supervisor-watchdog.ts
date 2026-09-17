import * as net from "node:net";

/**
 * Env var carrying the fd number of the supervisor pipe's read end, set by the
 * parent (`AgentManager`) when it spawns a child pi process.
 */
export const SUPERVISOR_FD_ENV = "PI_SUBAGENT_SUPERVISOR_FD";

/**
 * Extra stdio slot used as the supervisor pipe: the parent holds the write end
 * (`child.stdio[SUPERVISOR_STDIO_SLOT]`) and the child reads that fd.
 */
export const SUPERVISOR_STDIO_SLOT = 3;

/**
 * Detect parent-process death via the supervisor pipe, event-driven with zero
 * polling.
 *
 * The parent spawns the child with a fourth stdio pipe slot; the parent holds
 * the write end (`child.stdio[3]`) open and never writes to it. When the parent
 * dies, the kernel closes its end of the pipe, the child sees EOF, and
 * `onParentDeath` fires exactly once. Child pi processes run their own
 * subagents the same way, so EOF propagates recursively down the whole tree.
 *
 * Node's fourth stdio slot is backed by a `socketpair` on Unix, so the fd is
 * wrapped with `net.Socket` rather than `fs.createReadStream`: `fs` streams
 * treat a size-0 stat as "nothing to read" and never deliver EOF, while a
 * socket stream emits `'end'` as soon as the peer closes. Verified empirically:
 * after the parent destroys its end, raw `fs.read` returns 0 within
 * milliseconds; only a socket-level reader surfaces that as an event.
 *
 * When `PI_SUBAGENT_SUPERVISOR_FD` is absent (e.g. a pi session started
 * directly by a user) the caller must not invoke this function and behavior is
 * completely unchanged.
 *
 * @param fd Read end of the supervisor pipe (the fd number passed via env).
 * @param onParentDeath Invoked exactly once when the pipe reaches EOF. Must
 *   shut the process down promptly: the parent is gone, nobody will consume
 *   this child's output or act on its results.
 * @returns Disposer: closes the fd and drops the callbacks without triggering
 *   `onParentDeath` (for normal exits where the parent is still alive).
 */
export function startSupervisorWatchdog(fd: number, onParentDeath: () => void): () => void {
	let disposed = false;
	let fired = false;
	const socket = new net.Socket({ fd, readable: true, writable: false });
	const trigger = () => {
		if (disposed || fired) return;
		fired = true;
		onParentDeath();
	};
	socket.on("data", () => {});
	socket.once("end", trigger);
	socket.once("close", trigger);
	socket.once("error", trigger);
	return () => {
		if (disposed) return;
		disposed = true;
		fired = true;
		socket.destroy();
	};
}
