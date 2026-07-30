import { mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

const [directory] = process.argv.slice(2);
if (!directory) throw new Error("Usage: crash-lock-worker <directory>");
const lockPath = join(directory, ".locks", "list-1");
await mkdir(lockPath, { recursive: true });
await writeFile(
	join(lockPath, "crashed.json"),
	JSON.stringify({
		version: 1,
		nonce: "crashed",
		pid: process.pid,
		host: hostname(),
		choosing: false,
		ticket: 1,
	}),
	"utf8",
);
