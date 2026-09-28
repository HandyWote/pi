import { FileTodoStore } from "../../src/store.ts";

const [directory, state = "ticketed"] = process.argv.slice(2);
if (!directory) throw new Error("Usage: crash-lock-worker <directory> [choosing|ticketed]");

const store = new FileTodoStore(directory, {
	async lockHook(phase) {
		if ((state === "choosing" && phase === "published") || (state === "ticketed" && phase === "acquired")) {
			process.exit(0);
		}
	},
});
await store.read("list-1");
