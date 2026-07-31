import { copyFile, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetAgentDir = join(repoRoot, ".artifacts", "pi-local-orchestration-agent");
const configuredAgentDir = process.env.PI_CODING_AGENT_DIR;
const defaultAgentDir = join(homedir(), ".pi", "agent");
const sourceAgentDir =
	configuredAgentDir && resolve(configuredAgentDir) !== targetAgentDir ? resolve(configuredAgentDir) : defaultAgentDir;

await mkdir(targetAgentDir, { recursive: true });

let settings = {};
try {
	settings = JSON.parse(await readFile(join(sourceAgentDir, "settings.json"), "utf8"));
} catch (error) {
	if (error?.code !== "ENOENT") throw error;
}

settings.packages = [];
settings.extensions = [
	join(repoRoot, "packages", "extensions", "pi-todo", "src", "index.ts"),
	join(repoRoot, "packages", "extensions", "pi-subagent", "src", "index.ts"),
];
await writeFile(join(targetAgentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });

for (const name of ["auth.json", "profiles.json", "models.json", "sandbox.json"]) {
	await linkOrCopy(join(sourceAgentDir, name), join(targetAgentDir, name));
}

const binDir = join(targetAgentDir, "bin");
await mkdir(binDir, { recursive: true });
for (const name of ["fd", "rg"]) {
	await linkOrCopy(join(sourceAgentDir, "bin", name), join(binDir, name));
}

const agentsDir = join(targetAgentDir, "agents");
await rm(agentsDir, { recursive: true, force: true });
await mkdir(agentsDir, { recursive: true });
await copyFile(
	join(repoRoot, "packages", "extensions", "pi-subagent", "test", "fixtures", "local-orchestration-worker.md"),
	join(agentsDir, "local-orchestration-worker.md"),
);

console.log(`Local Todo/Subagent state: ${relative(repoRoot, targetAgentDir)}`);

async function linkOrCopy(source, target) {
	try {
		await lstat(source);
	} catch (error) {
		if (error?.code === "ENOENT") return;
		throw error;
	}

	try {
		if ((await lstat(target)).isSymbolicLink() && (await readlink(target)) === source) return;
		await rm(target, { force: true });
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}

	try {
		await symlink(source, target, "file");
	} catch {
		await copyFile(source, target);
	}
}
