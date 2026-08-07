import { describe, expect, it } from "vitest";
import { evaluateMetric } from "./resource-alerts";

describe("resource alert debounce", () => {
  it("alerts and recovers only after consecutive samples", () => {
    let state = { breaches: 0, recoveries: 0, active: false };
    for (let index = 0; index < 2; index++) { const result = evaluateMetric(state, 95, 90, 3); state = result.state; expect(result.event).toBeUndefined(); }
    let result = evaluateMetric(state, 95, 90, 3); state = result.state; expect(result.event).toBe("alert");
    for (let index = 0; index < 2; index++) { result = evaluateMetric(state, 40, 90, 3); state = result.state; expect(result.event).toBeUndefined(); }
    expect(evaluateMetric(state, 40, 90, 3).event).toBe("recovery");
  });
});
