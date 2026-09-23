/**
 * Atomic file persistence for profile-owned files.
 *
 * Writes go to a temp file in the same directory and are moved into place
 * with rename, so a crash never leaves a truncated profile-state.json or
 * models.json. rename(2) is atomic within one filesystem; the temp file is
 * created in the target directory for exactly that reason.
 */

import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

function writeAllSync(fd: number, data: string): void {
	let written = 0;
	while (written < data.length) {
		written += writeSync(fd, data, written);
	}
}

/**
 * Write `data` to `filePath` atomically (temp file + rename in the same
 * directory). Creates the parent directory when missing. Permissions on the
 * final file are set via the temp file's mode before rename.
 */
export function atomicWriteFileSync(filePath: string, data: string, mode = 0o600): void {
	const dir = dirname(filePath);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tempPath = join(dir, `.${filePath.split("/").pop() ?? "file"}.${randomBytes(6).toString("hex")}.tmp`);
	let tempFd: number | undefined;
	try {
		tempFd = openSync(tempPath, "wx", mode);
		writeAllSync(tempFd, data);
		closeSync(tempFd);
		tempFd = undefined;
		renameSync(tempPath, filePath);
	} catch (error) {
		if (tempFd !== undefined) {
			try {
				closeSync(tempFd);
			} catch {
				// best-effort close during error handling
			}
		}
		try {
			unlinkSync(tempPath);
		} catch {
			// temp file may not exist if open failed; nothing to clean
		}
		throw error;
	}
}

/** Read a file as UTF-8 text, or undefined when missing. */
export function readTextFileIfExists(filePath: string): string | undefined {
	try {
		return readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}
}
