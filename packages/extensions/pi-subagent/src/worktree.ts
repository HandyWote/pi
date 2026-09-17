import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AgentWorktree {
	path: string;
	cwd: string;
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
		const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
		const repository = stdout.trim();
		if (!repository) throw new Error(`Cannot find a git repository from ${cwd}`);
		const relativeCwd = path.relative(repository, path.resolve(cwd));
		if (relativeCwd === ".." || relativeCwd.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCwd))
			throw new Error(`Working directory is outside repository: ${cwd}`);
		const worktreeCwd = path.join(destination, relativeCwd);
		if (fs.existsSync(path.join(destination, ".git"))) return { path: destination, cwd: worktreeCwd, branch };
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
		return { path: destination, cwd: worktreeCwd, branch };
	}

	private async resolveRepository(cwd: string): Promise<string> {
		const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
		});
		return stdout.trim();
	}

	async cleanup(worktreePath: string, cwd: string): Promise<string | undefined> {
		try {
			const repository = await this.resolveRepository(cwd);
			await execFileAsync("git", ["-C", repository, "worktree", "remove", worktreePath], { encoding: "utf8" });
			return undefined;
		} catch (error: unknown) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	/**
	 * Remove a worktree during session teardown: normal removal first, then
	 * `--force` for dirty worktrees, then a bare directory deletion plus prune.
	 * Unlike cleanup() this never retains the worktree: teardown time is not
	 * the moment to preserve uncommitted changes.
	 */
	async cleanupForced(worktreePath: string, cwd: string): Promise<string | undefined> {
		const removeError = await this.cleanup(worktreePath, cwd);
		if (removeError === undefined) return undefined;
		try {
			const repository = await this.resolveRepository(cwd);
			await execFileAsync("git", ["-C", repository, "worktree", "remove", "--force", worktreePath], {
				encoding: "utf8",
			});
			return undefined;
		} catch {
			// Fall through to hard removal below.
		}
		try {
			await fs.promises.rm(worktreePath, { recursive: true, force: true });
		} catch (error: unknown) {
			return error instanceof Error ? error.message : String(error);
		}
		try {
			const repository = await this.resolveRepository(cwd);
			await execFileAsync("git", ["-C", repository, "worktree", "prune"], { encoding: "utf8" });
		} catch {
			// The repository may be gone; the directory removal already happened.
		}
		return undefined;
	}
}
