import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AgentWorktree {
	path: string;
	branch: string;
}

export class WorktreeService {
	private readonly worktreesDir: string;

	constructor(rootDir: string) {
		this.worktreesDir = path.join(rootDir, "worktrees");
	}

	async create(agentId: string, cwd: string): Promise<AgentWorktree> {
		const destination = path.join(this.worktreesDir, agentId);
		const branch = `pi-subagent/${agentId}`;
		if (fs.existsSync(path.join(destination, ".git"))) return { path: destination, branch };
		const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
		const repository = stdout.trim();
		if (!repository) throw new Error(`Cannot find a git repository from ${cwd}`);
		await fs.promises.mkdir(this.worktreesDir, { recursive: true });
		try {
			await execFileAsync("git", ["-C", repository, "show-ref", "--verify", `refs/heads/${branch}`], {
				encoding: "utf8",
			});
		} catch {
			await execFileAsync("git", ["-C", repository, "branch", branch, "HEAD"], { encoding: "utf8" });
		}
		await execFileAsync("git", ["-C", repository, "worktree", "add", destination, branch], {
			encoding: "utf8",
		});
		return { path: destination, branch };
	}

	async cleanup(worktreePath: string, cwd: string): Promise<string | undefined> {
		try {
			const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
				encoding: "utf8",
			});
			await execFileAsync("git", ["-C", stdout.trim(), "worktree", "remove", worktreePath], { encoding: "utf8" });
			return undefined;
		} catch (error: unknown) {
			return error instanceof Error ? error.message : String(error);
		}
	}
}
