import * as os from "node:os";
import * as path from "node:path";

export { parseFrontmatter } from "../../../../coding-agent/src/utils/frontmatter.ts";

export const CONFIG_DIR_NAME = ".pi";

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}
