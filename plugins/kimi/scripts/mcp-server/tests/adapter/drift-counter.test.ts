import { beforeEach, describe, expect, it } from "vitest";
import {
  DRIFT_THRESHOLD,
  getDriftState,
  recordDriftEvent,
  resetDriftState,
} from "../../src/adapter/drift-counter.js";

beforeEach(() => {
  resetDriftState();
});

describe("drift-counter", () => {
  it("starts at count=0, active=false, recent=[]", () => {
    expect(getDriftState()).toEqual({ count: 0, active: false, recentKinds: [] });
  });

  it("threshold is 3 (matches P0-G §'CLI shape drift detection')", () => {
    expect(DRIFT_THRESHOLD).toBe(3);
  });

  it("becomes active only after threshold events", () => {
    recordDriftEvent("missing_trailing_marker");
    expect(getDriftState().active).toBe(false);
    recordDriftEvent("missing_trailing_marker");
    expect(getDriftState().active).toBe(false);
    recordDriftEvent("stream_json_malformed");
    expect(getDriftState().active).toBe(true);
    expect(getDriftState().count).toBe(3);
  });

  it("captures the kinds of events recorded", () => {
    recordDriftEvent("missing_trailing_marker");
    recordDriftEvent("stream_json_malformed");
    expect(getDriftState().recentKinds).toEqual([
      "missing_trailing_marker",
      "stream_json_malformed",
    ]);
  });

  it("recentKinds keeps the most recent N events only (bounded)", () => {
    for (let i = 0; i < 20; i++) {
      recordDriftEvent("missing_trailing_marker");
    }
    const state = getDriftState();
    expect(state.count).toBe(20);
    expect(state.active).toBe(true);
    expect(state.recentKinds.length).toBeLessThanOrEqual(10);
  });

  it("resetDriftState() returns to the initial state", () => {
    recordDriftEvent("missing_trailing_marker");
    recordDriftEvent("missing_trailing_marker");
    recordDriftEvent("missing_trailing_marker");
    expect(getDriftState().active).toBe(true);
    resetDriftState();
    expect(getDriftState()).toEqual({ count: 0, active: false, recentKinds: [] });
  });
});
