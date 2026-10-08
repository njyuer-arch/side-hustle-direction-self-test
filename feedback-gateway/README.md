# 匿名 GitHub 反馈入口

这是一个无状态、只写入的远程 MCP Worker。它不保存反馈数据库，也不提供反馈列表或读取工具。报告修订完成后，AI 向用户展示最终去身份摘要并取得明确同意，再调用唯一工具 submit_anonymous_self_test_feedback。Worker 校验后使用项目 GitHub App 身份，将一条 Markdown 文件写到项目公开仓库。

测试者不需要 GitHub 账号；Git 提交显示项目机器人身份，反馈文件不记录测试者用户名或 GitHub 账号。反馈和 Git 历史对公众可见。Cloudflare 会接收网络请求并可能处理来源 IP 等网络元数据；Worker 只把来源地址用于粗略限流，不写入 GitHub。这是反馈记录匿名，不代表网络层完全匿名。共享网络可能共用限流额度。

## GitHub App

为项目创建 GitHub App，只授予 **Contents: read and write**，并且只安装到 njyuer-arch/side-hustle-direction-self-test。不要授予 Issues、Pull requests、组织或管理权限。App 私钥只保存为 Worker secret。

配置 Worker secrets：GITHUB_APP_ID、GITHUB_APP_INSTALLATION_ID、GITHUB_APP_PRIVATE_KEY（PEM 私钥）。代码把仓库与 main 分支固定，不能由调用者指定目标路径。

## 本地验证

    npm install
    npm test
    npx wrangler dev

MCP 地址是 /mcp，健康检查是 /health。本地测试用内存 mock，不访问 GitHub，也不创建公开反馈。

## 部署

在项目自己的 Cloudflare 账号里设置以上三个 secret，再运行 npx wrangler deploy。这是独立 Cloudflare Worker 服务，不是 Sites 或 Pages。部署后用 MCP Inspector 验证：没有同意时必须失败；测试成功写入用 mock，不要向公开 feedback 目录塞测试条目。确认部署与真实连接成功后，才把 MCP 地址提供给测试者。

## 边界

- 缺少修订完成、摘要展示、明确公开同意、随机 UUID、或文本超长时拒绝写入。
- 检查常见手机号、邮箱和身份证号；AI 仍须主动删除姓名、公司名、地址和可拼接身份的信息，自动检查无法识别所有间接身份线索。
- 调用方在第一次尝试时生成 UUID 和 YYYY-MM，并在超时重试时保持两者不变：相同编号和相同内容返回原条目；相同编号但内容不同则拒绝覆盖。
- 不接收原始聊天全文、用户账号、联系方式或任意仓库路径。
