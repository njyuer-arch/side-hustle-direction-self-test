import test from "node:test";
import assert from "node:assert/strict";
import { feedbackPath, submitFeedback, validateFeedback } from "./feedback.js";

const input = () => ({
  tool_version: "V0.9",
  submission_id: "123e4567-e89b-42d3-a456-426614174000",
  submission_month: "2026-10",
  post_report_updates_complete: true,
  summary_was_shown: true,
  public_consent_confirmed: true,
  consent_phrase: "同意",
  final_summary: "用户指出访谈应核实每周可投入时间。",
  optional_feedback: "第一版建议缺少市场核查。",
});

test("fails closed unless revisions, shown summary, and explicit public consent are confirmed", () => {
  for (const changes of [
    { post_report_updates_complete: false },
    { summary_was_shown: false },
    { public_consent_confirmed: false },
    { consent_phrase: "" },
  ]) assert.throws(() => validateFeedback({ ...input(), ...changes }));
});

test("rejects common direct identifiers", () => {
  assert.throws(() => validateFeedback({ ...input(), final_summary: "电话 13812345678" }));
  assert.throws(() => validateFeedback({ ...input(), optional_feedback: "test@example.com" }));
});

test("places a random UUID in the public feedback path", () => {
  assert.equal(
    feedbackPath("123e4567-e89b-42d3-a456-426614174000", "2026-10"),
    "feedback/entries/2026-10/123e4567-e89b-42d3-a456-426614174000.md",
  );
});

test("same UUID and payload returns the prior receipt without a duplicate write", async () => {
  const clean = validateFeedback(input());
  let saved = null;
  let writes = 0;
  const github = {
    async getFile() { return saved; },
    async createFile(path, content) {
      writes += 1;
      saved = { content, url: "https://github.com/repo/" + path, commit: "abc123" };
      return saved;
    },
  };
  const now = new Date("2026-10-08T00:00:00Z");
  const first = await submitFeedback(clean, github, now);
  const retry = await submitFeedback(clean, github, now);
  assert.equal(writes, 1);
  assert.equal(retry.url, first.url);
  assert.equal(retry.alreadySubmitted, true);
  assert.match(saved.content, /测试者 GitHub 账号：未收集/);
});

test("does not overwrite a different payload that reuses the same UUID", async () => {
  const clean = validateFeedback(input());
  let saved = null;
  const github = {
    async getFile() { return saved; },
    async createFile(path, content) {
      saved = { content, url: "https://github.com/repo/" + path, commit: "abc123" };
      return saved;
    },
  };
  const now = new Date("2026-10-08T00:00:00Z");
  await submitFeedback(clean, github, now);
  await assert.rejects(
    submitFeedback(validateFeedback({ ...input(), final_summary: "不同内容" }), github, now),
    /已用于不同内容/,
  );
});

test("recovers a successful GitHub write whose response was lost", async () => {
  const clean = validateFeedback(input());
  let saved = null;
  const github = {
    async getFile() { return saved; },
    async createFile(path, content) {
      saved = { content, url: "https://github.com/repo/" + path, commit: "abc123" };
      throw new Error("simulated timeout after commit");
    },
  };
  const result = await submitFeedback(clean, github, new Date("2026-10-08T00:00:00Z"));
  assert.equal(result.alreadySubmitted, true);
  assert.match(result.url, /github\.com/);
});
