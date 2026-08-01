/**
 * Session state for the permission gate.
 *
 * Holds the permission mode and denial tracking for one interactive
 * session. The session handler calls `resetSession()` on `session_start`:
 * mode returns to the default and denial counters are cleared
 * (session-scoped rules live in PermissionRuleStore and are cleared by the
 * handler separately). Pure logic, no pi API dependency, so it unit-tests
 * in isolation.
 */

export type PermissionMode = "chat" | "acceptEdits" | "auto";

export const DEFAULT_MODE: PermissionMode = "chat";

export interface DenialTracking {
	consecutiveDenials: number;
	totalDenials: number;
}

export interface SessionState {
	/** Current permission mode. Defaults to "chat". */
	getMode(): PermissionMode;
	setMode(mode: PermissionMode): void;

	/** Denial counters (circuit breaker for auto mode). */
	getDenialTracking(): DenialTracking;
	/** Increment both counters; returns the new state. */
	recordDenial(): DenialTracking;
	/** Clear the consecutive counter; returns the new state. */
	recordSuccess(): DenialTracking;
	resetDenialTracking(): void;

	/** Call on session_start: reset mode to the default and clear counters. */
	resetSession(): void;
}

export class SessionStateImpl implements SessionState {
	private mode: PermissionMode = DEFAULT_MODE;
	private consecutiveDenials = 0;
	private totalDenials = 0;

	getMode(): PermissionMode {
		return this.mode;
	}

	setMode(mode: PermissionMode): void {
		this.mode = mode;
	}

	/** Returns a copy so callers cannot mutate internal state. */
	getDenialTracking(): DenialTracking {
		return {
			consecutiveDenials: this.consecutiveDenials,
			totalDenials: this.totalDenials,
		};
	}

	recordDenial(): DenialTracking {
		this.consecutiveDenials += 1;
		this.totalDenials += 1;
		return this.getDenialTracking();
	}

	recordSuccess(): DenialTracking {
		this.consecutiveDenials = 0;
		return this.getDenialTracking();
	}

	resetDenialTracking(): void {
		this.consecutiveDenials = 0;
		this.totalDenials = 0;
	}

	resetSession(): void {
		this.mode = DEFAULT_MODE;
		this.resetDenialTracking();
	}
}
