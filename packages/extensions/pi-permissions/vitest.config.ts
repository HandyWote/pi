import { fileURLToPath } from "node:url";

const ai = fileURLToPath(new URL("../../ai/src", import.meta.url));

export default {
	test: {
		include: ["test/**/*.test.ts"],
	},
	resolve: {
		alias: [
			{
				find: /^@handy_wote\/pi-coding-agent$/,
				replacement: fileURLToPath(new URL("../../coding-agent/src/index.ts", import.meta.url)),
			},
			{ find: /^@handy_wote\/pi-ai$/, replacement: `${ai}/index.ts` },
			{ find: /^@handy_wote\/pi-ai\/compat$/, replacement: `${ai}/compat.ts` },
			{ find: /^@handy_wote\/pi-ai\/api\/(.+)$/, replacement: `${ai}/api/$1.ts` },
			{ find: /^@handy_wote\/pi-ai\/providers\/(.+)$/, replacement: `${ai}/providers/$1.ts` },
			{
				find: /^@handy_wote\/pi-agent-core$/,
				replacement: fileURLToPath(new URL("../../agent/src/index.ts", import.meta.url)),
			},
			{
				find: /^@handy_wote\/pi-tui$/,
				replacement: fileURLToPath(new URL("../../tui/src/index.ts", import.meta.url)),
			},
		],
	},
};
