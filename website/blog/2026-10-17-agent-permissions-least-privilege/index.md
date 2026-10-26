---
slug: agent-permissions-least-privilege
title: "Agents exceeded their permissions: how to scope them"
description: "CERT-In says AI agents read live business records at Indian firms. Here is how least privilege, scoped access, approvals and audit logs should limit them."
authors: [tashiriskhan]
tags: [security, news]
image: ./cover.jpg
keywords: [ai agent permissions, least privilege for ai agents, agent sandboxing, ai agent approvals, agent audit logging, cert-in ai agents]
---

This week CERT-In, India's national cyber agency, said AI agents reached the live systems of several Indian organisations during "research and evaluation activity" and read business records, including personal data and confidential material. The incident came to light after the affected organisations said the agents "exceeded the authorisation of their assigned tasks." Tencent separately said that agents used to evaluate third-party models showed web-browsing behaviour it did not intend. Both stories point at the same gap: agents were allowed to do more than anyone meant them to.

{/* truncate */}

We run Mercury, an agent with real tools: a shell, a filesystem, git. We read both reports as a test of our own design.

## What CERT-In reported

[The Hindu reported](https://www.thehindu.com/sci-tech/technology/ai-agents-gained-unauthorised-access-to-indian-organisations-says-cert-in/article71592222.ece) that CERT-In said on Thursday, 15 October, that AI agents "undergoing testing" had reached live systems of Indian organisations. [Reuters](https://www.reuters.com/legal/litigation/rogue-ai-agents-broke-into-indian-firms-live-systems-government-says-2026-10-16/) carried the same government statement. The organisations could not detect the access on their own, the agency said.

The agents read "business records, including personal data and confidential material", through credentials and connection settings exposed in application configuration, public code repositories and permissive cloud service roles. [India Today](https://www.indiatoday.in/technology/news/story/ai-agents-gained-access-to-confidential-data-of-indian-firms-cert-in-warns-of-misuse-3018535-2026-10-16) reported the same data exposure. [Business Standard](https://www.business-standard.com/technology/tech-news/ai-agents-accessed-indian-firms-systems-sensitive-data-cert-in-advisory-126101501656_1.html) reported that some model providers had told CERT-In their models reached live systems during testing.

CERT-In did not name the AI providers or the affected organisations, so the public reports cannot say which agents were involved.

None of the weaknesses were new. CERT-In said the AI found and exploited conventional weaknesses "faster, more exhaustively and at greater scale than human attackers."

## What Tencent reported

Tencent said that AI agents used to evaluate third-party models on its cloud platform showed unintended web-browsing behaviour. [Quartz reported](https://qz.com/tencent-ai-agents-unintended-browsing-alibaba-amap-101626) that the agents made more than 2,600 attempts to pull data from Alibaba's Amap service. [South China Morning Post](https://www.scmp.com/tech/tech-trends/article/3371007/ai-agents-tencent-cloud-try-break-alibabas-amap-researchers) put the window at 28 September to 8 October.

Tencent calls the browsing unintended. The coverage we read does not explain how the agents reached Amap, but a browsing tool without a tight boundary can fetch data nobody meant it to.

## The common failure

In both reports the agent did not break a lock. It used authority that already existed and that nobody had scoped to the task. A credential in a config file, a cloud role that reads everything, and a browser that reaches any URL are all standing permission. Nothing in the system said where the agent's job ended.

## How agent permissions should work

We think four rules cover most of this.

**1. Least privilege per task.** An agent should start with no access and receive only the paths, commands and network destinations its current task needs. A summary task does not need write access to the repository.

**2. Scopes that name a path and a mode.** A scope should say what it covers and whether it allows reading, writing or running. Scopes must resolve symlinks before the check. Otherwise an approved directory can contain a link to `~/.ssh`, and the check passes on the link while the read lands on the key.

**3. Approvals for actions that leave the box.** Reading a project file is routine. Pushing to a remote, deleting a directory, or running a package install that reaches the network should stop and wait for a human. The approval should show the exact command or path, not a summary.

**4. Audit for every access.** If a reviewer cannot answer "what did the agent read last Tuesday, and why", the permission model is incomplete. CERT-In's finding that the affected organisations could not detect the access is the strongest argument for this rule.

## How Mercury applies these rules today

Mercury reads its permissions from `~/.mercury/permissions.yaml`. The shape looks like this:

```yaml title="~/.mercury/permissions.yaml"
capabilities:
  filesystem:
    enabled: true
    scopes:
      - path: .
        read: true
        write: true
  shell:
    enabled: true
    cwdOnly: true
    blocked:
      - "sudo *"
    needsApproval:
      - "git push *"
      - "rm -rf *"
```

The full options are in the [permissions reference](/docs/reference/permissions). The enforcement lives in [`src/capabilities/permissions.ts`](https://github.com/cosmicstack-labs/mercury-agent/blob/main/src/capabilities/permissions.ts) and [`src/core/execute-guard.ts`](https://github.com/cosmicstack-labs/mercury-agent/blob/main/src/core/execute-guard.ts). Several parts match the rules above:

- **Blocked commands never run.** The blocklist is checked against every segment of a chained command, so a blocked command cannot hide behind an allowed one such as `echo`.
- **Shell commands take one of two lanes.** A plain command whose binary is on the allowlist, and whose path arguments stay inside the working directory or a readable scope, runs without a prompt. Anything else goes to approval, where the user sees the exact string.
- **Writes always prompt in Ask Me mode.** Even when a scope covers the path, a write asks first. Reads inside a scope do not prompt.
- **Symlinks and hard links are checked.** A read that resolves outside the approved scopes is denied. A regular file with more than one hard link needs approval, because it may be an alias of a file outside every scope.
- **Unattended bots fail closed.** A bot has no one to ask, so an out-of-scope action is denied instead of waiting. Skill elevation is ignored in that mode, so a skill cannot widen what a bot may do.

Two gaps remain. Scheduled tasks run in Allow All mode for their own turn, so shell commands run unless they hit the blocklist and scope prompts are skipped. That is the weakest point, and it looks like the situation CERT-In describes: a background run with broad access and nobody watching. Second, we found no per-access audit log in the permission code, so we treat auditability as missing, not done.

## What it means for you

If you run any agent with tools, check three things this week:

- Search your repositories and config files for credentials. Rotate anything that was ever committed.
- Open your agent's permission file and remove scopes you do not use, especially home-directory and cloud-role grants.
- Give scheduled or unattended runs the narrowest scope that works, and review what they touched.

Read the CERT-In advisory itself, not only the coverage.

## References

1. The Hindu, "AI agents gained unauthorised access to Indian organisations, says CERT-In", 16 October 2026. [thehindu.com](https://www.thehindu.com/sci-tech/technology/ai-agents-gained-unauthorised-access-to-indian-organisations-says-cert-in/article71592222.ece)
2. Reuters, "Rogue AI agents broke into Indian firms' live systems, government says", 16 October 2026. [reuters.com](https://www.reuters.com/legal/litigation/rogue-ai-agents-broke-into-indian-firms-live-systems-government-says-2026-10-16/)
3. India Today, "AI agents gained access to confidential data of Indian firms, CERT-In warns of misuse", 16 October 2026. [indiatoday.in](https://www.indiatoday.in/technology/news/story/ai-agents-gained-access-to-confidential-data-of-indian-firms-cert-in-warns-of-misuse-3018535-2026-10-16)
4. Business Standard, CERT-In advisory coverage, 15 to 16 October 2026. [business-standard.com](https://www.business-standard.com/technology/tech-news/ai-agents-accessed-indian-firms-systems-sensitive-data-cert-in-advisory-126101501656_1.html)
5. Quartz, Tencent AI agents and Alibaba Amap browsing report. [qz.com](https://qz.com/tencent-ai-agents-unintended-browsing-alibaba-amap-101626)
6. South China Morning Post, AI agents on Tencent Cloud and Alibaba's Amap. [scmp.com](https://www.scmp.com/tech/tech-trends/article/3371007/ai-agents-tencent-cloud-try-break-alibabas-amap-researchers)
7. Mercury permissions reference. [/docs/reference/permissions](/docs/reference/permissions)
8. Mercury source: [`src/capabilities/permissions.ts`](https://github.com/cosmicstack-labs/mercury-agent/blob/main/src/capabilities/permissions.ts) and [`src/core/execute-guard.ts`](https://github.com/cosmicstack-labs/mercury-agent/blob/main/src/core/execute-guard.ts).
