import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectClient, installFakeCanvas, type RecordedRequest } from "./helpers/fake-canvas.js";

const CLOUD = { id: 101, name: "(26FS-Full) INTRO TO CLOUD COMPUTING (001)", course_code: "2268-1_20CS5165001", workflow_state: "available", term: { id: 1, name: "Fall 2026" } };
const NETWORKS = { id: 102, name: "(26FS-Full) COMPUTER NETWORKS (001)", course_code: "2268-1_20CS4065001", workflow_state: "available", term: { id: 1, name: "Fall 2026" } };
const DUE = "2026-11-05T04:59:00Z"; // Wed Nov 4 11:59pm America/New_York

const studentEnrollment = (current: number | null, final: number | null, letter: string | null = null) => [
  { type: "student", role: "StudentEnrollment", computed_current_score: current, computed_final_score: final, computed_current_grade: letter },
];

const assignment500 = {
  id: 500,
  course_id: 101,
  name: "Lab 5 - Kubernetes",
  description: '<p>Deploy a cluster. See <a href="/courses/101/files/900">lab.txt</a> and <a href="/courses/101/pages/lab-guide">Lab guide</a> and <a href="https://kubernetes.io">docs</a>.</p>',
  due_at: DUE,
  points_possible: 10,
  html_url: "https://canvas.test/courses/101/assignments/500",
  submission_types: ["online_upload"],
  allowed_extensions: ["pdf"],
  allowed_attempts: 2,
  rubric: [
    { id: "c1", description: "Cluster runs", points: 6, ratings: [{ id: "r1", description: "Works", points: 6 }, { id: "r2", description: "Broken", points: 0 }] },
    { id: "c2", description: "Write-up", points: 4, long_description: "<p>Explain your design</p>" },
  ],
};

// Weighted course: Homework 40% (drop lowest 1), Exams 60%.
const assignmentGroups = [
  {
    id: 1, name: "Homework", group_weight: 40, rules: { drop_lowest: 1 },
    assignments: [
      { id: 501, name: "HW1", points_possible: 10, published: true, due_at: DUE, submission: { score: 8, workflow_state: "graded", posted_at: DUE } },
      { id: 502, name: "HW2", points_possible: 10, published: true, submission: { score: 4, workflow_state: "graded", posted_at: DUE, late: true } },
      { id: 503, name: "HW3", points_possible: 10, published: true, submission: { score: null, workflow_state: "unsubmitted", posted_at: null, missing: true } },
    ],
  },
  {
    id: 2, name: "Exams", group_weight: 60, rules: {},
    assignments: [
      { id: 504, name: "Midterm", points_possible: 50, published: true, submission: { score: 45, workflow_state: "graded", posted_at: DUE } },
      { id: 505, name: "Final", points_possible: 50, published: true, submission: { score: 30, workflow_state: "graded", posted_at: null } },
    ],
  },
];

function routes() {
  return {
    "/courses": (url: URL) =>
      url.searchParams.getAll("include[]").includes("total_scores")
        ? [{ ...CLOUD, enrollments: studentEnrollment(86, 51) }, { ...NETWORKS, enrollments: studentEnrollment(null, null) }]
        : [{ ...CLOUD, enrollments: [{ type: "student" }] }, { ...NETWORKS, enrollments: [{ type: "ta" }] }],
    "/users/self/profile": { id: 7, name: "Test Student", login_id: "tstudent", time_zone: "America/New_York" },
    "/planner/items": [
      { course_id: 101, plannable_id: 500, plannable_type: "assignment", plannable_date: DUE, plannable: { title: "Lab 5 - Kubernetes", points_possible: 10, due_at: DUE }, submissions: { submitted: false, missing: false } },
      { course_id: 101, plannable_id: 501, plannable_type: "assignment", plannable_date: DUE, plannable: { title: "Already done", due_at: DUE }, submissions: { submitted: true } },
      { course_id: 102, plannable_id: 9, plannable_type: "calendar_event", plannable_date: "2026-11-04T19:00:00Z", plannable: { title: "Networks lecture", start_at: "2026-11-04T19:00:00Z", end_at: "2026-11-04T20:30:00Z", location_name: "Zoom" }, submissions: false },
      { course_id: 101, plannable_id: 77, plannable_type: "assessment_request", plannable_date: DUE, plannable: { title: "Peer review: Lab 4" }, submissions: false },
    ],
    "/users/self/missing_submissions": [{ ...assignment500, id: 503, name: "HW3", due_at: "2026-10-01T03:59:00Z" }],
    "/courses/101": (url: URL) => ({
      ...CLOUD,
      apply_assignment_group_weights: true,
      restrict_quantitative_data: false,
      grading_standard_id: null,
      grading_scheme: [["A", 0.94], ["A-", 0.9], ["B+", 0.87], ["B", 0.84], ["B-", 0.8], ["C+", 0.77], ["C", 0.74], ["C-", 0.7], ["D+", 0.67], ["D", 0.64], ["D-", 0.61], ["F", 0]],
      enrollments: studentEnrollment(86, 51, "B"),
      syllabus_body: url.searchParams.getAll("include[]").includes("syllabus_body") ? "<h1>Grading</h1><p>Homework 40%</p>" : undefined,
    }),
    "/courses/101/assignment_groups": assignmentGroups,
    "/courses/101/assignments": [assignment500, { ...assignment500, id: 600, name: "Quiz shell", quiz_id: 700, is_quiz_assignment: true }, { ...assignment500, id: 601, name: "New Quiz 1", is_quiz_lti_assignment: true, submission: { workflow_state: "unsubmitted", score: null, submitted_at: null } }],
    "/courses/102/assignments": [{ ...assignment500, id: 650, course_id: 102, name: "Subnetting worksheet" }],
    "/courses/101/assignments/500": assignment500,
    "/courses/101/assignments/500/submissions/self": {
      id: 1, workflow_state: "graded", score: 7, grade: "7", attempt: 1, submitted_at: DUE, posted_at: DUE, late: false, missing: false,
      submission_comments: [{ author_name: "Prof X", comment: "Good cluster, thin write-up", created_at: DUE }],
      rubric_assessment: { c1: { points: 6 }, c2: { points: 1, comments: "Explain scaling" } },
    },
    "/files/900": { id: 900, filename: "lab.txt", display_name: "lab.txt", "content-type": "text/plain", url: "https://canvas.test/download/900", size: 100, updated_at: DUE },
    "/courses/101/pages/lab-guide": { page_id: 1, url: "lab-guide", title: "Lab guide", body: "<p>Use kubectl apply</p>", html_url: "https://canvas.test/courses/101/pages/lab-guide", updated_at: DUE },
    "/courses/101/pages": [{ page_id: 1, url: "lab-guide", title: "Lab guide", html_url: "x", updated_at: DUE }],
    "/courses/101/front_page": { page_id: 2, url: "home", title: "Welcome", body: "<p>Hello class</p>", html_url: "x", updated_at: DUE },
    "/courses/101/modules": [
      {
        id: 1, name: "Week 10", position: 1, state: "started",
        items: [
          { id: 11, module_id: 1, title: "Lab guide", type: "Page", page_url: "lab-guide", html_url: "x", position: 1, completion_requirement: { type: "must_view", completed: true } },
          { id: 12, module_id: 1, title: "Lab 5 - Kubernetes", type: "Assignment", content_id: 500, html_url: "x", position: 2, completion_requirement: { type: "must_submit", completed: false }, content_details: { due_at: DUE, points_possible: 10 } },
        ],
      },
    ],
    "/courses/101/quizzes": [{ id: 700, title: "Quiz 3", quiz_type: "assignment", due_at: DUE, unlock_at: null, lock_at: null, time_limit: 30, allowed_attempts: 2, points_possible: 20, question_count: 10, published: true, html_url: "x" }],
    "/courses/101/quizzes/700": { id: 700, title: "Quiz 3", quiz_type: "assignment", due_at: DUE, unlock_at: null, lock_at: null, time_limit: 30, allowed_attempts: 2, points_possible: 20, question_count: 10, scoring_policy: "keep_highest", html_url: "x", assignment_id: 600 },
    "/courses/101/quizzes/700/submissions": { quiz_submissions: [{ attempt: 1, score: 15, kept_score: 15, started_at: DUE, finished_at: DUE, workflow_state: "complete", attempts_left: 1 }] },
    "/courses/101/discussion_topics": [{ id: 800, title: "Week 10 discussion", message: "<p>Discuss</p>", html_url: "x", posted_at: DUE, discussion_subentry_count: 2, unread_count: 1, assignment_id: 610, author: { display_name: "Prof X" } }],
    "/courses/101/discussion_topics/800": { id: 800, title: "Week 10 discussion", message: "<p>What is a pod?</p>", html_url: "x", posted_at: DUE, author: { display_name: "Prof X" }, assignment_id: 610 },
    "/courses/101/discussion_topics/800/view": {
      participants: [{ id: 1, display_name: "Alice" }, { id: 2, display_name: "Bob" }],
      unread_entries: [21],
      view: [{ id: 20, user_id: 1, message: "<p>A pod is a group of containers</p>", created_at: DUE, replies: [{ id: 21, user_id: 2, message: "<p>Agreed</p>", created_at: DUE }] }],
    },
    "/announcements": [{ id: 900, title: "Exam moved", message: "<p>The exam is now Friday</p>", posted_at: DUE, context_code: "course_101", read_state: "unread", html_url: "x" }],
    "/conversations": [{ id: 55, subject: "Office hours", workflow_state: "unread", last_message: "Moved to 3pm", last_message_at: DUE, message_count: 1, participants: [{ id: 3, name: "Prof X" }], context_name: "CLOUD" }],
    "/conversations/unread_count": { unread_count: "4" },
    "/conversations/55": { id: 55, subject: "Office hours", workflow_state: "unread", participants: [{ id: 3, name: "Prof X" }], messages: [{ id: 2, author_id: 3, created_at: DUE, body: "Moved to 3pm" }, { id: 1, author_id: 3, created_at: "2026-11-01T12:00:00Z", body: "Office hours are at 2pm" }], context_name: "CLOUD" },
    "/users/self/groups": [{ id: 66, name: "Team Rocket", members_count: 3, context_name: "CLOUD" }, { id: 67, name: "Old team", members_count: 2, concluded: true }],
    "/groups/66": { id: 66, name: "Team Rocket", members_count: 3, context_name: "CLOUD" },
    "/groups/66/users": [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }],
    "/courses/101/users": [{ id: 3, name: "Prof X", email: "profx@uc.edu", enrollments: [{ type: "TeacherEnrollment", role: "TeacherEnrollment" }] }],
    "/users/self/activity_stream": [
      { id: 1, type: "Submission", title: null, created_at: DUE, updated_at: DUE, read_state: false, course_id: 101, score: 7, assignment: { name: "Lab 5", points_possible: 10 }, submission_comments: [{ author_name: "Prof X", comment: "Nice" }] },
      { id: 2, type: "Announcement", title: "Exam moved", message: "<p>Friday</p>", created_at: DUE, updated_at: DUE, read_state: true, course_id: 101 },
    ],
    "/users/self/activity_stream/summary": [{ type: "Submission", count: 1, unread_count: 1 }],
    "/courses/101/files": [{ id: 900, display_name: "lab.txt", size: 2048, updated_at: DUE }, { id: 901, display_name: "secret.txt", size: 1, updated_at: DUE, hidden_for_user: true }],
    "/courses/102/files": new Response("forbidden", { status: 403 }),
  };
}

describe("canvas-mcp tools (against a fake Canvas)", () => {
  let requests: RecordedRequest[];
  let call: Awaited<ReturnType<typeof connectClient>>["call"];

  beforeEach(async () => {
    requests = installFakeCanvas(routes());
    ({ call } = await connectClient());
  });

  afterEach(() => vi.unstubAllGlobals());

  it("lists exactly the expected tools", async () => {
    const { client } = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "calculate_grade", "find_assignment", "gather_assignment_context", "get_assignment", "get_discussions",
      "get_file_text", "get_grades", "get_groups", "get_inbox", "get_missing_work", "get_page", "get_quizzes",
      "get_recent_activity", "get_upcoming", "list_announcements", "list_courses", "list_files", "list_modules",
      "list_people", "search_course",
    ]);
  });

  it("list_courses shows profile, ids and non-student roles", async () => {
    const { text } = await call("list_courses");
    expect(text).toContain("You: Test Student (user_id=7");
    expect(text).toContain("101 | INTRO TO CLOUD COMPUTING | 2268-1_20CS5165001 | Fall 2026");
    expect(text).toContain("role: ta");
  });

  it("get_upcoming hides finished work by default and shows local times", async () => {
    const { text } = await call("get_upcoming");
    expect(text).toContain("Wed Nov 4 11:59pm · [assignment] Lab 5 - Kubernetes · INTRO TO CLOUD COMPUTING · 10pts · ✗ not submitted (course_id=101 assignment_id=500)");
    expect(text).toContain("[event] Networks lecture");
    expect(text).toContain("2pm–3:30pm");
    expect(text).toContain("[peer review] Peer review: Lab 4");
    expect(text).not.toContain("Already done");
    expect(text).toContain("1 completed item(s) hidden");
    const withDone = await call("get_upcoming", { include_done: true });
    expect(withDone.text).toContain("Already done");
  });

  it("get_upcoming filters to a course resolved by name", async () => {
    await call("get_upcoming", { course_id: "networks" });
    const planner = requests.find((r) => r.url.pathname.endsWith("/planner/items"))!;
    expect(planner.url.searchParams.getAll("context_codes[]")).toEqual(["course_102"]);
  });

  it("get_missing_work lists missing items with ids", async () => {
    const { text } = await call("get_missing_work");
    expect(text).toContain("[missing] HW3 · INTRO TO CLOUD COMPUTING");
    expect(text).toContain("assignment_id=503");
  });

  it("get_grades without a course summarizes every course", async () => {
    const { text } = await call("get_grades");
    expect(text).toContain("101 INTRO TO CLOUD COMPUTING: 86.00% (final w/ zeros 51.00%)");
    expect(text).toContain("102 COMPUTER NETWORKS: no grade yet");
  });

  it("get_grades with a course lists every assignment by group", async () => {
    const { text } = await call("get_grades", { course_id: "CS5165" });
    expect(text).toContain("## Homework · weight 40% · drop lowest 1");
    expect(text).toContain("- 502 HW2 · 4/10 (40.0%) · graded, late");
    expect(text).toContain("- 503 HW3 · -/10 · missing");
    expect(text).toContain("- 505 Final · -/50 · grade not posted yet");
  });

  it("calculate_grade matches Canvas, applies what-ifs, and solves a letter target", async () => {
    const base = await call("calculate_grade", { course_id: 101 });
    expect(base.text).toContain("Current (graded work only): 86.00% (B)");
    expect(base.text).toContain("✓ matches Canvas");
    expect(base.text).toContain("Final (ungraded counted as 0): 51.00%");
    expect(base.text).toContain("dropped: HW2");

    const whatIf = await call("calculate_grade", { course_id: 101, what_if: { "503": 10 } });
    expect(whatIf.text).toContain("What-if current grade: 90.00% (A-)");

    // 43 + 50x >= 90 on the two remaining items -> x = 94%.
    const target = await call("calculate_grade", { course_id: 101, target_letter: "A-" });
    expect(target.text).toContain("Need 94.00% (same %) on every remaining assignment.");
    expect(target.text).toContain("(lower bound of A-)");
  });

  it("calculate_grade rejects unknown what-if ids", async () => {
    const { text, isError } = await call("calculate_grade", { course_id: 101, what_if: { "999": 1 } });
    expect(isError).toBe(true);
    expect(text).toContain("999");
  });

  it("find_assignment searches all courses", async () => {
    const { text } = await call("find_assignment", { query: "subnetting" });
    expect(text).toContain("Subnetting worksheet · COMPUTER NETWORKS");
    expect(text).toContain("course_id=102 assignment_id=650");
  });

  it("get_assignment includes submission, comments, compact rubric and links", async () => {
    const { text } = await call("get_assignment", { course_id: "cloud", assignment_id: 500 });
    expect(text).toContain("submit via online_upload (pdf) · 2 attempt(s) allowed");
    expect(text).toContain("graded 7/10");
    expect(text).toContain("Prof X");
    expect(text).toContain("Good cluster, thin write-up");
    expect(text).toContain("- Cluster runs (6 pts) → you got 6");
    expect(text).toContain("ratings: 6 Works | 0 Broken");
    expect(text).toContain("grader: Explain scaling");
    expect(text).toContain("file: lab.txt (file_id=900)");
    expect(text).toContain("page: Lab guide (page_url=lab-guide)");
    expect(text).not.toContain('"ratings"'); // no raw JSON
  });

  it("gather_assignment_context bundles module, linked file/page text and mentions", async () => {
    const { text } = await call("gather_assignment_context", { course_id: 101, assignment_id: 500 });
    expect(text).toContain("## Module: Week 10");
    expect(text).toContain(">> [Assignment] Lab 5 - Kubernetes");
    expect(text).toContain("contents of /download/900");
    expect(text).toContain("Use kubectl apply");
    expect(text).toContain("https://kubernetes.io");
  });

  it("search_course indexes and finds course content", async () => {
    const { text } = await call("search_course", { course_id: 101, query: "kubectl" });
    expect(text).toContain("[page] Lab guide (page-lab-guide)");
  });

  it("list_modules shows ids and completion state", async () => {
    const { text } = await call("list_modules", { course_id: 101 });
    expect(text).toContain("- ✓ [Page] Lab guide (page_url=lab-guide)");
    expect(text).toContain("- ☐ [Assignment] Lab 5 - Kubernetes · due Wed Nov 4 11:59pm · 10pts (assignment_id=500)");
  });

  it("get_page lists pages, reads front page and syllabus", async () => {
    expect((await call("get_page", { course_id: 101 })).text).toContain("Lab guide (page_url=lab-guide)");
    expect((await call("get_page", { course_id: 101, page_url: "front_page" })).text).toContain("Hello class");
    expect((await call("get_page", { course_id: 101, page_url: "syllabus" })).text).toContain("Homework 40%");
    expect((await call("get_page", { course_id: 101, page_url: "lab-guide" })).text).toContain("kubectl");
  });

  it("list_files hides hidden files and explains a 403", async () => {
    const ok = await call("list_files", { course_id: 101 });
    expect(ok.text).toContain("file_id=900 lab.txt · 2KB");
    expect(ok.text).not.toContain("secret.txt");
    const forbidden = await call("list_files", { course_id: 102 });
    expect(forbidden.text).toContain("hides this Files list");
  });

  it("get_file_text extracts and pages text", async () => {
    const { text } = await call("get_file_text", { file_id: 900 });
    expect(text).toContain("# lab.txt (file_id=900)");
    expect(text).toContain("contents of /download/900");
  });

  it("get_quizzes lists quizzes and shows attempts", async () => {
    const list = await call("get_quizzes", { course_id: 101 });
    expect(list.text).toContain("quiz_id=700 Quiz 3 · due Wed Nov 4 11:59pm · 30min · 2 attempts · 20pts");
    expect(list.text).toContain("assignment_id=601 New Quiz 1 (New Quiz)");
    const detail = await call("get_quizzes", { course_id: 101, quiz_id: 700 });
    expect(detail.text).toContain("attempt 1: complete · 15/20");
    expect(detail.text).toContain("Attempts left: 1");
  });

  it("get_quizzes falls back to the assignment for a New Quiz id", async () => {
    const { text } = await call("get_quizzes", { course_id: 101, quiz_id: 500 });
    expect(text).toContain("(New Quiz, assignment_id=500)");
  });

  it("get_discussions lists topics and renders a threaded view", async () => {
    const list = await call("get_discussions", { course_id: 101 });
    expect(list.text).toContain("topic_id=800 Week 10 discussion · by Prof X · 2 replies (1 unread) · graded (assignment_id=610)");
    const thread = await call("get_discussions", { course_id: 101, topic_id: 800 });
    expect(thread.text).toContain("What is a pod?");
    expect(thread.text).toContain("- Alice · Wed Nov 4 11:59pm: A pod is a group of containers");
    expect(thread.text).toContain("  - Bob · Wed Nov 4 11:59pm · NEW: Agreed");
  });

  it("list_announcements covers all courses when none is given", async () => {
    const { text } = await call("list_announcements");
    expect(text).toContain("INTRO TO CLOUD COMPUTING · Exam moved · UNREAD (course_id=101 topic_id=900)");
    const req = requests.find((r) => r.url.pathname.endsWith("/announcements"))!;
    expect(req.url.searchParams.getAll("context_codes[]")).toEqual(["course_101", "course_102"]);
  });

  it("get_inbox lists and reads conversations without marking them read", async () => {
    const list = await call("get_inbox");
    expect(list.text).toContain("4 unread conversation(s) total.");
    expect(list.text).toContain("conversation_id=55 UNREAD Office hours · Prof X");
    const thread = await call("get_inbox", { conversation_id: 55 });
    expect(thread.text.indexOf("Office hours are at 2pm")).toBeLessThan(thread.text.indexOf("Moved to 3pm"));
    const req = requests.find((r) => r.url.pathname.endsWith("/conversations/55"))!;
    expect(req.url.searchParams.get("auto_mark_as_read")).toBe("false");
  });

  it("get_groups lists active groups and members", async () => {
    const list = await call("get_groups");
    expect(list.text).toContain("group_id=66 Team Rocket");
    expect(list.text).not.toContain("Old team");
    expect((await call("get_groups", { group_id: 66 })).text).toContain("2 member(s): Alice, Bob");
  });

  it("list_people shows staff with email", async () => {
    const { text } = await call("list_people", { course_id: 101 });
    expect(text).toContain("Prof X · teacher · user_id=3 · profx@uc.edu");
    const req = requests.find((r) => r.url.pathname.endsWith("/courses/101/users"))!;
    expect(req.url.searchParams.getAll("enrollment_type[]")).toEqual(["teacher", "ta"]);
  });

  it("get_recent_activity summarizes grades and feedback", async () => {
    const { text } = await call("get_recent_activity");
    expect(text).toContain("Unread: 1 Submission");
    expect(text).toContain("Submission · INTRO TO CLOUD COMPUTING · Lab 5 · NEW · score 7/10 · comment from Prof X: Nice");
  });

  it("returns a friendly error for an ambiguous course name", async () => {
    const { text, isError } = await call("get_grades", { course_id: "26FS" });
    expect(isError).toBe(true);
    expect(text).toContain("matches several courses");
  });

  it("returns a friendly error for a missing object", async () => {
    const { text, isError } = await call("get_assignment", { course_id: 101, assignment_id: 12345 });
    expect(isError).toBe(true);
    expect(text).toContain("Not found in Canvas (404)");
  });

  it("tells a permission 401 apart from an invalid token", async () => {
    vi.unstubAllGlobals();
    installFakeCanvas({
      ...routes(),
      "/courses/101/assignments/500": new Response(JSON.stringify({ status: "unauthorized", errors: [{ message: "user not authorized to perform that action" }] }), { status: 401 }),
      "/users/self/missing_submissions": new Response(JSON.stringify({ errors: [{ message: "Invalid access token." }] }), { status: 401 }),
    });
    const hidden = await call("get_assignment", { course_id: 101, assignment_id: 500 });
    expect(hidden.text).toContain("don't have permission");
    const badToken = await call("get_missing_work");
    expect(badToken.text).toContain("invalid or expired");
  });

  it("never sends anything but GET to Canvas", async () => {
    await call("get_upcoming");
    await call("get_inbox", { conversation_id: 55 });
    await call("calculate_grade", { course_id: 101 });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });
});
