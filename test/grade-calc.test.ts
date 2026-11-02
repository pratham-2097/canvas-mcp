import { describe, expect, it } from "vitest";
import * as gc from "../src/grades/calc.js";

function item(id: string, group: string, points: number, score: number | null, extra: Partial<gc.GradedItem> = {}): gc.GradedItem {
  return { assignmentId: id, groupId: group, pointsPossible: points, score, excused: false, pendingReview: false, countsTowardGrade: true, ...extra };
}

function group(id: string, weight = 0, extra: Partial<gc.GroupRules> = {}): gc.GroupRules {
  return { groupId: id, weight, dropLowest: 0, dropHighest: 0, neverDrop: new Set(), ...extra };
}

describe("canvasRound", () => {
  it("rounds half up on the decimal value like Ruby (60.995 -> 61)", () => {
    expect(gc.canvasRound(60.995)).toBe(61);
    expect(gc.canvasRound(89.994)).toBe(89.99);
    expect(gc.canvasRound(-1.005)).toBe(-1.01);
  });
});

describe("calculateCourse", () => {
  it("unweighted: current uses graded work only, final counts ungraded as 0", () => {
    const groups = [group("g")];
    const items = [item("1", "g", 10, 8), item("2", "g", 10, null)];
    expect(gc.calculateCourse(groups, items, false).percent).toBeCloseTo(80);
    expect(gc.calculateCourse(groups, items, false, true).percent).toBeCloseTo(40);
  });

  it("weighted: sums score/possible*weight", () => {
    const groups = [group("a", 40), group("b", 60)];
    const items = [item("1", "a", 10, 9), item("2", "b", 20, 15)];
    expect(gc.calculateCourse(groups, items, true).percent).toBeCloseTo(81);
  });

  it("weighted: rescales to 100 when a group has nothing graded", () => {
    const groups = [group("a", 40), group("b", 60)];
    const items = [item("1", "a", 10, 9), item("2", "b", 20, null)];
    const grade = gc.calculateCourse(groups, items, true);
    expect(grade.percent).toBeCloseTo(90);
    expect(grade.countedWeight).toBe(40);
  });

  it("weighted with no counted weight gives no grade", () => {
    expect(gc.calculateCourse([group("a", 0)], [item("1", "a", 10, 5)], true).percent).toBeNull();
  });

  it("excludes excused, pending-review and not-counted work", () => {
    const items = [
      item("1", "g", 10, 10),
      item("2", "g", 10, 0, { excused: true }),
      item("3", "g", 10, 0, { pendingReview: true }),
      item("4", "g", 10, 0, { countsTowardGrade: false }),
    ];
    expect(gc.calculateCourse([group("g")], items, false).percent).toBeCloseTo(100);
  });
});

describe("drop rules", () => {
  it("drop lowest keeps the best combined ratio, not the lowest percentage", () => {
    // 5/10 and 2/4 are both 50%, but dropping 5/10 leaves (9+2)/14 = 78.57%
    // while dropping 2/4 leaves 14/20 = 70%. Canvas drops 5/10.
    const groups = [group("g", 0, { dropLowest: 1 })];
    const items = [item("1", "g", 10, 5), item("2", "g", 10, 9), item("3", "g", 4, 2)];
    const grade = gc.calculateCourse(groups, items, false);
    expect(grade.groups[0]!.dropped).toEqual(["1"]);
    expect(grade.percent).toBeCloseTo((11 / 14) * 100);
  });

  it("never_drop protects an assignment from being dropped", () => {
    const groups = [group("g", 0, { dropLowest: 1, neverDrop: new Set(["1"]) })];
    const items = [item("1", "g", 10, 1), item("2", "g", 10, 9), item("3", "g", 10, 6)];
    const grade = gc.calculateCourse(groups, items, false);
    expect(grade.groups[0]!.dropped).toEqual(["3"]);
    expect(grade.percent).toBeCloseTo(50);
  });

  it("always keeps at least one droppable assignment", () => {
    const groups = [group("g", 0, { dropLowest: 5 })];
    const grade = gc.calculateCourse(groups, [item("1", "g", 10, 3), item("2", "g", 10, 7)], false);
    expect(grade.groups[0]!.kept).toEqual(["2"]);
  });

  it("drop highest removes the best-ratio item", () => {
    const groups = [group("g", 0, { dropHighest: 1 })];
    const grade = gc.calculateCourse(groups, [item("1", "g", 10, 10), item("2", "g", 10, 6), item("3", "g", 10, 7)], false);
    expect(grade.groups[0]!.dropped).toEqual(["1"]);
  });
});

describe("what-if and targets", () => {
  const groups = [group("g")];
  const items = [item("1", "g", 10, 8), item("2", "g", 10, null)];

  it("applies hypothetical scores as graded", () => {
    const scenario = gc.applyHypotheticalScores(items, { "2": 10 });
    expect(gc.calculateCourse(groups, scenario, false).percent).toBeCloseTo(90);
  });

  it("finds the uniform percent needed on remaining work", () => {
    // (8 + 10x) / 20 >= 0.85  ->  x >= 0.9
    expect(gc.requiredUniformPercent(groups, items, false, 85).requiredPercent).toBe(90);
    expect(gc.requiredUniformPercent(groups, items, false, 90).requiredPercent).toBe(100);
  });

  it("reports already secured and extra-credit-only targets", () => {
    expect(gc.requiredUniformPercent(groups, items, false, 40).requiredPercent).toBe(0);
    const r = gc.requiredUniformPercent(groups, items, false, 95);
    expect(r.requiredPercent).toBe(110);
    expect(r.remainingPoints).toBe(10);
  });

  it("reports unreachable targets as null", () => {
    expect(gc.requiredUniformPercent(groups, items, false, 150).requiredPercent).toBeNull();
  });
});

describe("letters", () => {
  it("assigns the letter from the Canvas-rounded score", () => {
    expect(gc.letterForPercent(89.995, gc.CANVAS_DEFAULT_SCHEME)).toBe("A-");
    expect(gc.letterForPercent(89.99, gc.CANVAS_DEFAULT_SCHEME)).toBe("B+");
    expect(gc.letterForPercent(-5, gc.CANVAS_DEFAULT_SCHEME)).toBe("F");
  });

  it("parses both scheme shapes and points-based bounds", () => {
    expect(gc.parseGradingScheme([["A", 0.9], ["F", 0]])).toEqual([["A", 0.9], ["F", 0]]);
    expect(gc.parseGradingScheme([{ name: "P", value: 0.6 }, { name: "NP", value: 0 }])).toEqual([["P", 0.6], ["NP", 0]]);
    expect(gc.parseGradingScheme([["A", 3.6], ["F", 0]], 4)).toEqual([["A", 0.9], ["F", 0]]);
    expect(gc.parseGradingScheme([["A"]])).toBeNull();
  });

  it("finds letters exactly, then case-insensitively", () => {
    expect(gc.findLetter("A-", gc.CANVAS_DEFAULT_SCHEME)).toEqual(["A-", 90]);
    expect(gc.findLetter("b+", gc.CANVAS_DEFAULT_SCHEME)).toEqual(["B+", 87]);
    expect(gc.findLetter("Z", gc.CANVAS_DEFAULT_SCHEME)).toBeNull();
  });
});

describe("buildGradeModel", () => {
  it("treats unposted submissions as ungraded and skips unpublished work", () => {
    const { groups, items } = gc.buildGradeModel([
      {
        id: 1,
        group_weight: 0,
        rules: { drop_lowest: 1 },
        assignments: [
          { id: 10, points_possible: 10, published: true, submission: { score: 9, posted_at: "2026-01-01T00:00:00Z", workflow_state: "graded" } },
          { id: 11, points_possible: 10, published: true, submission: { score: 2, posted_at: null, workflow_state: "graded" } },
          { id: 12, points_possible: 10, published: false, submission: null },
        ],
      },
    ]);
    expect(groups[0]!.dropLowest).toBe(1);
    expect(items.map((i) => [i.assignmentId, i.score, i.countsTowardGrade])).toEqual([
      ["10", 9, true],
      ["11", null, true],
      ["12", null, false],
    ]);
  });

  it("refuses a submissions list (observer token) instead of guessing", () => {
    expect(() => gc.buildGradeModel([{ id: 1, assignments: [{ id: 2, points_possible: 1, submission: [] }] }])).toThrow(gc.MalformedGradeData);
  });

  it("refuses duplicate assignment ids", () => {
    const a = { id: 2, points_possible: 1 };
    expect(() => gc.buildGradeModel([{ id: 1, assignments: [a] }, { id: 3, assignments: [a] }])).toThrow(/appears twice/);
  });

  it("labels statuses in plain language", () => {
    expect(gc.submissionStatuses({}, { missing: true, score: null })).toEqual(["missing"]);
    expect(gc.submissionStatuses({}, { score: 5, late: true, points_deducted: 1, posted_at: "x" })).toEqual(["graded", "late", "late penalty -1"]);
    expect(gc.submissionStatuses({}, { workflow_state: "graded", posted_at: null })).toEqual(["grade not posted yet"]);
  });
});
