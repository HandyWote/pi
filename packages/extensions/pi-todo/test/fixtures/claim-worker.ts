import { FileTodoStore } from "../../src/store.ts";

const [directory, owner] = process.argv.slice(2);
if (!directory || !owner) throw new Error("Usage: claim-worker <directory> <owner>");

try {
	const claim = await new FileTodoStore(directory).claim("list-1", "A", owner, 1);
	process.stdout.write(JSON.stringify(claim));
} catch (error) {
	process.stderr.write(error instanceof Error ? error.message : String(error));
	process.exitCode = 2;
}
