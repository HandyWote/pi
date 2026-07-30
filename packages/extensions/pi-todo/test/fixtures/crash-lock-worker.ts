import { mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

const [directory] = process.argv.slice(2);
if (!directory) throw new Error("Usage: crash-lock-worker <directory>");
const lockPath = join(directory, ".locks", "list-1.lock");
const reaperPath = `${lockPath}.reaper`;
await mkdir(lockPath, { recursive: true });
await mkdir(reaperPath, { recursive: true });
await writeFile(
	join(lockPath, "owner.json"),
	JSON.stringify({ pid: process.pid, host: hostname(), nonce: "crashed", createdAt: new Date().toISOString() }),
	"utf8",
);
