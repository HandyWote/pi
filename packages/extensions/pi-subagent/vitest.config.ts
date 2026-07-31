import { fileURLToPath } from "node:url";

export default {
	test: {
		include: ["test/**/*.test.ts"],
		exclude: ["test/e2e.test.ts", "test/integration.e2e.test.ts"],
	},
	resolve: {
		alias: {
			"@handy_wote/pi-coding-agent": fileURLToPath(new URL("./test/mocks/coding-agent.ts", import.meta.url)),
			"@handy_wote/pi-tui": fileURLToPath(new URL("../../tui/src/index.ts", import.meta.url)),
		},
	},
};
