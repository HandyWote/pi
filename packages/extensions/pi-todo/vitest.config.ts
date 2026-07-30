import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../../ai/src/index.ts", import.meta.url));
const aiSrcApi = fileURLToPath(new URL("../../ai/src/api", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../../ai/src/compat.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../../ai/src/oauth.ts", import.meta.url));
const aiSrcProviders = fileURLToPath(new URL("../../ai/src/providers", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../../agent/src/index.ts", import.meta.url));
const codingAgentSrcIndex = fileURLToPath(new URL("../../coding-agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../../tui/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		environment: "node",
		testTimeout: 30_000,
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@handy_wote\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@handy_wote\/pi-ai\/api\/(.+)$/, replacement: `${aiSrcApi}/$1.ts` },
			{ find: /^@handy_wote\/pi-ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@handy_wote\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@handy_wote\/pi-ai\/providers\/(.+)$/, replacement: `${aiSrcProviders}/$1.ts` },
			{ find: /^@handy_wote\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@handy_wote\/pi-coding-agent$/, replacement: codingAgentSrcIndex },
			{ find: /^@handy_wote\/pi-tui$/, replacement: tuiSrcIndex },
		],
	},
});
