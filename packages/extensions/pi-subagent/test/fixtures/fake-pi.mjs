const task = process.argv.at(-1) ?? "";
const delay = Number(/delay:(\d+)/.exec(task)?.[1] ?? 10);
const context = process.env.PI_AGENT_CONTEXT ?? "{}";

if (task.includes("ignore-term")) {
	process.on("SIGTERM", () => {});
}

console.log(
	JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
				{ type: "text", text: `started ${context}` },
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
	}),
);

setTimeout(() => {
	if (task.includes("fail")) {
		console.error("requested failure");
		process.exit(2);
	}
	console.log(
		JSON.stringify({
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
		}),
	);
	process.exit(0);
}, delay);

if (task.includes("ignore-term")) setInterval(() => {}, 1000);
