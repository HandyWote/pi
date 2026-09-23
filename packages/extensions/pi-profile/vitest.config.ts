import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		testTimeout: 30_000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		alias: [
			{
				find: /^@earendil-works\/pi-ai$/,
				replacement: fileURLToPath(new URL("./node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url)),
			},
		],
	},
});
