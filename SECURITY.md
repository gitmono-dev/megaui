# Security Policy

English · [中文](#中文)

## Supported versions

megaui is pre-release software (`0.x`). Security fixes are made on the `main` branch only;
there are no maintained release branches yet.

## Reporting a vulnerability

**Please do not open a public issue, pull request, or discussion for a security problem.**

Email <contact@gitmono.com>. This address is monitored and works whether or not the
repository is public. Describe the issue, the affected component and version or commit, and
steps to reproduce. A proof of concept helps, but please keep it free of real user data.

When this repository is public and private vulnerability reporting is enabled, you may instead
use GitHub's **Security** tab → **Report a vulnerability**
(<https://github.com/gitmono-dev/megaui/security/advisories/new>).

We aim to acknowledge a report within a few working days and to keep you informed while we
investigate and prepare a fix. Please give us a reasonable time to release a fix before any
public disclosure; we are happy to credit you in the advisory if you wish.

## Scope

In scope: the code in this repository, in particular authentication and session handling
(including the Feishu email-code sign-in), authorisation checks, the collaboration
server and its tickets, upload and storage handling, and the BFF that talks to mega2.

Out of scope: vulnerabilities in third-party dependencies that are not exploitable through
megaui (report those upstream), findings that need a compromised host or administrator
account, and denial of service through unrealistic request volume.

## Handling secrets

Never include real credentials, tokens, or personal data in a report, an issue, or a pull
request. If you find a secret committed to this repository, report it privately as above so
that it can be rotated.

---

## 中文

### 受支持的版本

megaui 目前是预发布软件（`0.x`），安全修复只在 `main` 分支进行，暂无长期维护的发布分支。

### 如何报告漏洞

**请不要用公开的 Issue、Pull Request 或讨论来报告安全问题。**

请发送到 <contact@gitmono.com>。该地址有人处理，仓库是否公开都可以使用。请说明问题、受影响的组件与版本或提交，以及复现步骤。概念验证有帮助，但请不要包含真实用户数据。

仓库公开且已启用私密漏洞报告后，也可以使用 GitHub 的 **Security** 标签页 → **Report a vulnerability**（<https://github.com/gitmono-dev/megaui/security/advisories/new>）。

我们会尽量在几个工作日内确认收到，并在调查与修复期间与你保持沟通。公开披露前请留出合理的修复时间；如你愿意，我们会在安全公告中致谢。

### 范围

范围内：本仓库的代码，尤其是认证与会话处理（含飞书邮箱验证码登录）、授权检查、协作服务及其票据、上传与存储处理，以及对接 mega2 的 BFF。

范围外：无法通过 megaui 利用的第三方依赖漏洞（请向上游报告）、需要主机或管理员账号已被攻破才能成立的问题，以及依靠不现实请求量的拒绝服务。

### 关于密钥

报告、Issue 或 Pull Request 中不要包含真实凭据、令牌或个人数据。如果发现仓库中提交了密钥，请按上述方式私密报告，以便轮换。
