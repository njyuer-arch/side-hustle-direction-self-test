const DIRECT_IDS = [
  /(?<!\d)1[3-9]\d{9}(?!\d)/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?<!\d)\d{17}[\dXx](?!\d)/,
];

export function validateFeedback(input) {
  if (input.post_report_updates_complete !== true) throw new Error("先完成报告后的补充和修订。");
  if (input.summary_was_shown !== true) throw new Error("必须先向用户展示最终去身份摘要。");
  if (input.public_consent_confirmed !== true || String(input.consent_phrase || "").trim().length < 2) {
    throw new Error("需要用户明确同意将最终摘要公开提交到 GitHub。");
  }
  if (!/^V0\.\d+$/.test(input.tool_version || "")) throw new Error("工具版本格式无效。");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.submission_id || "")) {
    throw new Error("需要随机生成的 UUID v4 作为安全重试编号。");
  }
  const summary = String(input.final_summary || "").trim();
  const evaluation = String(input.optional_feedback || "").trim();
  if (!summary || summary.length > 5000 || evaluation.length > 2000) throw new Error("内容为空或超过长度限制。");
  if (DIRECT_IDS.some((pattern) => pattern.test(summary + "\n" + evaluation))) {
    throw new Error("内容疑似含手机号、邮箱或身份证号，请删除后重试。");
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.submission_month || "")) {
    throw new Error("submission_month 必须是首次提交时生成的 YYYY-MM，并在重试时保持不变。");
  }
  return {
    version: input.tool_version,
    submissionId: input.submission_id.toLowerCase(),
    submissionMonth: input.submission_month,
    summary,
    evaluation,
  };
}

export function feedbackPath(id, month) {
  return "feedback/entries/" + month + "/" + id + ".md";
}

export async function payloadHash(feedback, cryptoApi = crypto) {
  const canonical = JSON.stringify({ version: feedback.version, summary: feedback.summary, evaluation: feedback.evaluation });
  const digest = await cryptoApi.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function submitFeedback(feedback, github, now = new Date(), cryptoApi = crypto) {
  const path = feedbackPath(feedback.submissionId, feedback.submissionMonth);
  const hash = await payloadHash(feedback, cryptoApi);
  const marker = "<!-- payload-sha256:" + hash + " -->";
  const existing = await github.getFile(path);
  if (existing) {
    if (!existing.content.includes(marker)) throw new Error("提交编号已用于不同内容，未覆盖现有反馈。");
    return { ...existing, path, alreadySubmitted: true };
  }
  const evaluation = feedback.evaluation ? "\n## 用户自愿评价\n\n" + feedback.evaluation + "\n" : "";
  const content = [
    "# 副业方向自测匿名反馈",
    "",
    "- 工具版本：" + feedback.version,
    "- 提交时间（UTC）：" + now.toISOString(),
    "- 测试者 GitHub 账号：未收集",
    "",
    "## 最终去身份摘要",
    "",
    feedback.summary,
    evaluation,
    marker,
    "",
  ].join("\n");
  try {
    const created = await github.createFile(path, content, "Add anonymous self-test feedback");
    return { ...created, path, alreadySubmitted: false };
  } catch (error) {
    const afterError = await github.getFile(path);
    if (afterError && afterError.content.includes(marker)) return { ...afterError, path, alreadySubmitted: true };
    throw error;
  }
}
