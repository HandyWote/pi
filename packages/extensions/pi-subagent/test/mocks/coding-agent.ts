import * as os from "node:os";
import * as path from "node:path";

export { parseFrontmatter } from "../../../../coding-agent/src/utils/frontmatter.ts";

export const CONFIG_DIR_NAME = ".pi";

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: (text) => text,
		link: (text) => text,
		linkUrl: (text) => text,
		code: (text) => text,
		codeBlock: (text) => text,
		codeBlockBorder: (text) => text,
		quote: (text) => text,
		quoteBorder: (text) => text,
		hr: (text) => text,
		listBullet: (text) => text,
		bold: (text) => text,
		italic: (text) => text,
		underline: (text) => text,
		strikethrough: (text) => text,
	};
}

export type MarkdownTheme = import("@handy_wote/pi-tui").MarkdownTheme;
