import * as fs from "node:fs";
import * as path from "node:path";

const task = process.argv.at(-1) ?? "";
const delay = Number(/delay:(\d+)/.exec(task)?.[1] ?? 10);
const context = process.env.PI_AGENT_CONTEXT ?? "{}";
const option = (name) => {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
};
const sessionId = option("--session-id");
const sessionDir = option("--session-dir");
if (!sessionId || !sessionDir) throw new Error("Missing child session arguments");
fs.mkdirSync(sessionDir, { recursive: true });
const sessionPath = path.join(sessionDir, `${sessionId}.jsonl`);
const priorSession = fs.existsSync(sessionPath) ? fs.readFileSync(sessionPath, "utf8") : "";
if (!priorSession) fs.writeFileSync(sessionPath, `${JSON.stringify({ type: "session", id: sessionId })}\n`);
fs.appendFileSync(sessionPath, `${JSON.stringify({ type: "task", task })}\n`);
const readyFile = /ready-file:(\S+)/.exec(task)?.[1];
const emit = (event) => fs.writeSync(process.stdout.fd, `${JSON.stringify(event)}\n`);

if (task.includes("ignore-term")) {
	process.on("SIGTERM", () => {});
}
if (task.includes("benign-stderr")) console.error("Created new session with requested ID");

	emit({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
				{
					type: "text",
					text: `started ${context} prior-context:${priorSession.includes("Task:")} cwd:${process.cwd()}`,
				},
			],
			api: "faux",
			provider: "faux",
			model: "faux-model",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 2,
				cacheWrite: 1,
				totalTokens: 18,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
	});
if (readyFile) fs.writeFileSync(readyFile, String(process.pid));

setTimeout(() => {
	if (task.includes("fail")) {
		console.error("requested failure");
		process.exit(2);
	}
	emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `finished ${task}` }],
				api: "faux",
				provider: "faux",
				model: "faux-model",
				usage: {
					input: 3,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 5,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		});
	emit({ type: "agent_settled" });
	if (task.includes("settle-hang")) return;
	process.exitCode = 0;
}, delay);

if (task.includes("ignore-term")) setInterval(() => {}, 1000);
