import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { submitFeedback, validateFeedback } from "./feedback.js";

const API = "https://api.github.com";
const OWNER = "njyuer-arch";
const REPO = "side-hustle-direction-self-test";
const BRANCH = "main";

function b64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function privateKeyBytes(pem) {
  const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const clean = pem.replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----|-----END (?:RSA )?PRIVATE KEY-----|\s/g, "");
  const binary = atob(clean);
  const der = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  if (!isPkcs1) return der;
  const lengthBytes = (length) => {
    if (length < 128) return [length];
    const bytes = [];
    for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 255);
    return [0x80 | bytes.length, ...bytes];
  };
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...lengthBytes(der.length), ...der];
  const sequence = [0x02, 0x01, 0x00, ...algorithm, ...octet];
  return new Uint8Array([0x30, ...lengthBytes(sequence.length), ...sequence]);
}

async function appJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = b64url(new TextEncoder().encode(JSON.stringify({ iat: now - 30, exp: now + 540, iss: env.GITHUB_APP_ID })));
  const unsigned = head + "." + body;
  const key = await crypto.subtle.importKey(
    "pkcs8", privateKeyBytes(env.GITHUB_APP_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return unsigned + "." + b64url(new Uint8Array(signature));
}

async function apiRequest(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "side-hustle-anonymous-feedback-gateway",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const raw = await response.text();
  let json = {};
  try { json = raw ? JSON.parse(raw) : {}; } catch {}
  return { response, json };
}

async function githubClient(env) {
  const jwt = await appJwt(env);
  const installation = await apiRequest(
    API + "/app/installations/" + encodeURIComponent(env.GITHUB_APP_INSTALLATION_ID) + "/access_tokens",
    jwt,
    { method: "POST", body: JSON.stringify({ repositories: [REPO], permissions: { contents: "write" } }) },
  );
  if (!installation.response.ok || !installation.json.token) throw new Error("无法取得仓库专用写入令牌。");
  const token = installation.json.token;
  const fileUrl = (path) => API + "/repos/" + OWNER + "/" + REPO + "/contents/" +
    path.split("/").map(encodeURIComponent).join("/");
  return {
    async getFile(path) {
      const result = await apiRequest(fileUrl(path) + "?ref=" + BRANCH, token);
      if (result.response.status === 404) return null;
      if (!result.response.ok) throw new Error("无法核对 GitHub 上的提交状态。");
      const binary = atob(String(result.json.content || "").replace(/\s/g, ""));
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      return { content: new TextDecoder().decode(bytes), url: result.json.html_url, commit: result.json.sha };
    },
    async createFile(path, content, message) {
      const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(content)));
      const result = await apiRequest(fileUrl(path), token, {
        method: "PUT",
        body: JSON.stringify({ message, content: encoded, branch: BRANCH }),
      });
      if (!result.response.ok || !result.json.content?.html_url || !result.json.commit?.sha) {
        throw new Error("GitHub 未确认写入成功。");
      }
      return { url: result.json.content.html_url, commit: result.json.commit.sha };
    },
  };
}

function createServer(context, env) {
  const server = new McpServer({ name: "side-hustle-feedback", version: "1.0.0" });
  const clientAddress = context?.requestInfo?.headers.get("cf-connecting-ip") || "unknown";
  server.registerTool(
    "submit_anonymous_self_test_feedback",
    {
      title: "提交副业自测匿名反馈",
      description:
        "仅在报告后的补充和修订全部结束、已向用户展示最终去身份摘要、且用户随后明确同意公开提交时调用。consent_phrase 填用户实际说出的明确同意原话，例如“同意”。报告前表示愿意反馈不算授权。首次调用时生成随机 UUID 与当前 YYYY-MM；发生超时重试时必须复用相同 UUID、月份和内容。只提交最终摘要和用户自愿评价，不得提交聊天全文、姓名、公司名、联系方式、地址或可识别细节。测试者无需 GitHub 账号。成功后只依据返回的 GitHub 条目链接确认入库。",
      inputSchema: {
        tool_version: z.string().regex(/^V0\.\d+$/),
        submission_id: z.string().uuid(),
        submission_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
        post_report_updates_complete: z.boolean(),
        summary_was_shown: z.boolean(),
        public_consent_confirmed: z.boolean(),
        consent_phrase: z.string(),
        final_summary: z.string().max(5000),
        optional_feedback: z.string().max(2000).optional().default(""),
      },
    },
    async (input) => {
      try {
        const feedback = validateFeedback(input);
        if (env.SUBMIT_LIMITER && clientAddress !== "unknown") {
          const limit = await env.SUBMIT_LIMITER.limit({ key: clientAddress });
          if (!limit.success) throw new Error("此网络的提交次数暂时过多，请稍后再试。");
        }
        const result = await submitFeedback(feedback, await githubClient(env));
        const receipt = { status: "success", url: result.url, path: result.path, alreadySubmitted: result.alreadySubmitted };
        return { content: [{ type: "text", text: JSON.stringify(receipt) }], structuredContent: receipt };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: "未确认提交成功：" + (error instanceof Error ? error.message : "服务暂时不可用。") }],
        };
      }
    },
  );
  return server;
}

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok", { headers: { "cache-control": "no-store" } });
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    return createMcpHandler((context) => createServer(context, env))(request, env, ctx);
  },
};
