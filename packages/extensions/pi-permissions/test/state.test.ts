import { describe, expect, it } from "vitest";
import { DEFAULT_MODE, SessionStateImpl } from "../src/state.ts";

describe("SessionState", () => {
	it("defaults to chat mode", () => {
		const state = new SessionStateImpl();
		expect(state.getMode()).toBe("chat");
		expect(DEFAULT_MODE).toBe("chat");
	});

	it("setMode/getMode round-trip", () => {
		const state = new SessionStateImpl();
		state.setMode("acceptEdits");
		expect(state.getMode()).toBe("acceptEdits");
		state.setMode("auto");
		expect(state.getMode()).toBe("auto");
		state.setMode("chat");
		expect(state.getMode()).toBe("chat");
	});

	it("recordDenial increments both counters", () => {
		const state = new SessionStateImpl();
		expect(state.recordDenial()).toEqual({ consecutiveDenials: 1, totalDenials: 1 });
		expect(state.recordDenial()).toEqual({ consecutiveDenials: 2, totalDenials: 2 });
		expect(state.getDenialTracking()).toEqual({ consecutiveDenials: 2, totalDenials: 2 });
	});

	it("recordSuccess clears consecutive but keeps total", () => {
		const state = new SessionStateImpl();
		state.recordDenial();
		state.recordDenial();
		const tracking = state.recordSuccess();
		expect(tracking).toEqual({ consecutiveDenials: 0, totalDenials: 2 });
		state.recordDenial();
		expect(state.getDenialTracking()).toEqual({ consecutiveDenials: 1, totalDenials: 3 });
	});

	it("resetDenialTracking zeroes both counters", () => {
		const state = new SessionStateImpl();
		state.recordDenial();
		state.recordSuccess();
		state.recordDenial();
		state.resetDenialTracking();
		expect(state.getDenialTracking()).toEqual({ consecutiveDenials: 0, totalDenials: 0 });
	});

	it("resetSession resets mode and denial tracking", () => {
		const state = new SessionStateImpl();
		state.setMode("auto");
		state.recordDenial();
		state.recordDenial();
		state.resetSession();
		expect(state.getMode()).toBe(DEFAULT_MODE);
		expect(state.getDenialTracking()).toEqual({ consecutiveDenials: 0, totalDenials: 0 });
	});

	it("getDenialTracking returns a copy (caller cannot mutate state)", () => {
		const state = new SessionStateImpl();
		state.recordDenial();
		const tracking = state.getDenialTracking();
		tracking.consecutiveDenials = 99;
		tracking.totalDenials = 99;
		expect(state.getDenialTracking()).toEqual({ consecutiveDenials: 1, totalDenials: 1 });
	});
});
