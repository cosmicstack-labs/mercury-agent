# 9 Safest, Most Secure, and Permission-Aware AI Agents for Real-World Tasks

> Grok, ChatGPT Work, Mercury, OpenClaw, Manus, Gemini agent for work, Devin, Claude Cowork and Comet compared on memory, where they run, what they can touch, scheduling, permissions, model choice and price.

Published 2026-11-05 by Tashir Khan. Tags: engineering, product, ai-agents, ai-agent-comparison, self-hosted-ai, ai-agent-memory.
Canonical: https://mercuryagent.sh/blog/six-ai-agents-compared-for-real-work

Nine AI agents now claim they can do real work for you: run tasks in the background, read your files, remember what you said, and keep going after you close the window. We build one of them, so read this as a comparison from a biased author. We gave each agent the same questions and the same amount of space, and we left a cell blank rather than guess. The agents appear in this order: Grok Bot, ChatGPT Work, Mercury, OpenClaw, Manus, Gemini agent for work, Devin, Claude Cowork and Comet.

## How we checked

Grok facts come from third-party guides to xAI's Grok Bot, which we could not confirm against xAI's own pages, so most Grok cells are "not checked". ChatGPT Work facts come from OpenAI's help pages and search summaries of them, because the help center returned HTTP 403 when we fetched it directly. Mercury facts come from our own release notes (1.4.0 to 1.5.0) and the Mercury repository's documentation. We did not run every Mercury feature for this post. OpenClaw facts come from its memory and sandboxing documentation. Manus facts come from its Help Center. Gemini facts come from Google Cloud's announcement of the Gemini agent for work (8 October 2026). Devin facts come from Cognition's product, Desktop, CLI and Review pages. Its prices are listed on Cognition's pricing page, and the figures below still need to be checked against it. Claude Cowork facts come from Anthropic's Claude Help Center. Comet facts come from Perplexity's own help, resource and changelog pages. All links are listed in the Sources section at the end.

Where a row says "not checked", we found no source we trust for that point, so we do not describe it.

## The nine at a glance

| Agent | Runs where | Memory | Computer / browser use | Background / scheduled work | Messaging / integrations | Multi-agent | Permissions / sandboxing | Model choice | Price |
|---|---|---|---|---|---|---|---|---|---|
| Grok Bot | xAI's cloud computer | Not checked | Works from its own cloud computer; not checked in detail | Described as always-on; schedules not checked | Signs into your apps (third-party guides) | Team Bots (third-party guides) | Not checked | Grok models; details not checked | $30 a month for SuperGrok, which includes Grok Bot access (xAI pricing page) |
| ChatGPT Work | Cloud Work on web and mobile for eligible plans; desktop Work with local files and apps where enabled | ChatGPT memory and Projects, varying by plan | Cloud browser (does not use your local profile or passwords) | Scheduled and event-triggered tasks | Connected apps | Not checked | Not checked | OpenAI models | Included with eligible ChatGPT plans; usage varies |
| Mercury | Background process on your machine; desktop app (1.5.0); web dashboard | Beliefs with evidence, confidence and status | Via Optimus plugin (desktop apps); limits by OS | Built-in scheduler (Mercury docs) | Telegram, Discord, Slack, Signal (repo docs); WhatsApp plugin | Sub-agents (Mercury docs) | Permissions docs; remote-device approval; signed updates | Several providers, including local Ollama | MIT, self-hosted |
| OpenClaw | Self-hosted Gateway on your machine or server | Markdown files: daily notes and `MEMORY.md`, optional semantic search | Not checked | Not checked | Chat channels such as Telegram, Discord and Slack | Per-agent settings and sandboxes | Sandbox off by default; Docker, Podman, SSH or OpenShell when on | Configurable providers | Open source, self-hosted |
| Manus | Cloud | Project and task context | Cloud browser and tools | Scheduled automations: 2 on Free, 20 on Pro and Team tiers | Not checked | Wide Research (parallel work); concurrent tasks | Not checked | Not checked | Free $0; Pro from $20/mo; higher Pro from $40/mo; Team from $20/seat/mo |
| Gemini agent for work | Web, mobile, desktop, command line, Workspace, Microsoft 365, Slack | Session, semantic, procedural and episodic memory | Via tools and connectors; not checked in detail | Scheduled tasks and event response; persistent execution | Workspace, Microsoft 365, Slack, Salesforce, Git, Jira, MCP servers | Sub-agents and coworker agents | Identity, policy, permissions, sandboxing, network gateways | Gemini and Claude models, routed per task | Not stated in the announcement |
| Devin | Cognition's cloud, in its own sandboxed virtual machine; also Desktop, CLI and Devin Review forms | Not checked | Shell, editor and browser inside its own machine | Runs autonomously on a task; can open pull requests | Not checked | Parallel cloud agents | Runs in its own sandbox; other controls not checked | Not checked | Pro $20/mo, Max $200/mo, Teams $80/mo plus $40/seat; not yet re-checked on Cognition's pricing page |
| Claude Cowork | Desktop on paid plans; web and mobile on Pro, Max, Ultra and Team | Not checked | Not checked in detail | Scheduled recurring tasks on paid plans | Not checked | Not checked | Not checked | Claude models | Included with paid Claude plans; prices not checked |
| Comet | Desktop browser (Chromium-compatible), from Perplexity | Not checked | Acts inside browser tabs; domain-specific agent access controls for admins | Not checked | Not checked | Not checked | Centralized policies for enterprise deployments | Not checked | Not checked |

## Grok

**What it is.** Grok Bot is xAI's agent product. Third-party guides describe it as an always-on agent that runs on its own cloud computer, separate from the chat app. We could not confirm that description on xAI's own pages. You can see the official site at [grok.com](https://grok.com).

**Where it runs.** On xAI's cloud computer, not on your machine. Third-party guides say it signs into your apps and works from there, so your work runs on xAI's infrastructure.

**What it remembers.** We did not verify Grok Bot's memory. xAI's cross-session memory announcement from 16 September 2026 applies to Grok Build, its terminal coding agent, not to Grok Bot. Grok Build stores conventions, decisions and project facts as Markdown notes, but we did not check whether Grok Bot works the same way, so we leave this blank.

**What it can do.** Third-party guides list app connections, Team Bots for shared use, and an Enterprise tier. We did not verify scheduling, browser control or the other features these guides mention, so we do not describe them as fact.

**Pricing.** xAI's [pricing page](https://x.ai/pricing) lists SuperGrok at $30 a month, which includes Grok Bot access. Third-party summaries also tie Grok Bot to Cursor plans, which we did not verify. Pricing in this space changes often, so check the page before you plan around it.

**Best for and where it falls short.** Best for people who already use Grok and want an agent that works in the cloud without setup on their own machine. The trade-off is that your data and tasks sit on xAI's infrastructure, and most of its features are still unverified here.

## ChatGPT Work

**What it is.** Work is the agent inside ChatGPT, built for longer, multi-step tasks and finished deliverables. OpenAI's help center describes it alongside Chat, which is for quick questions, and Codex in the desktop app. The official site is [chatgpt.com](https://chatgpt.com).

**Where it runs.** Cloud Work runs on web and mobile for eligible plans. Desktop Work can also use local files and apps where that is enabled. Availability varies by plan and surface, and it is still rolling out.

**What it remembers.** It uses ChatGPT memory and Projects, and how memory behaves depends on your plan and settings. OpenAI's [Projects help article](https://help.openai.com/en/articles/10169521-projects-in-chatgpt) covers project context, files, instructions and project memory. We have not verified how that memory behaves beyond what the article says.

**What it can do.** Work can work across files and connected apps, and it creates finished deliverables. It runs scheduled tasks and event-triggered tasks. Its cloud browser does not inherit your local profile, sessions or passwords. We did not confirm whether admins can control Work Cloud and Work Local separately.

**Pricing.** Work is included with eligible ChatGPT plans, including Free, Go, Plus, Pro, Business, Edu and Enterprise. Usage and availability vary by plan. We do not quote a dollar figure here, because the plan page we could reach did not show one.

**Best for and where it falls short.** Best for general knowledge work across files and apps, especially if you already pay for ChatGPT. Its strongest pull is the everyday tie-in with the rest of ChatGPT. Expect the feature set to change as rollout continues.

## Mercury

**What it is.** Mercury is an MIT-licensed AI agent from Cosmic Stack. It runs as one background process on your machine and has a terminal interface, a web dashboard and chat channels. The official site is [mercuryagent.sh](https://mercuryagent.sh).

**Where it runs.** On your own machine, or on a server you manage. Mercury 1.5.0 added a desktop app for macOS, Windows and Linux. The app is not code-signed yet, so the first launch asks for confirmation. Access from another device through a tunnel such as Tailscale or Cloudflare counts as remote. A new remote device needs approval with a 5-character code, sensitive actions from a remote device ask first, devices unused for 30 days are signed out, and the limit is 10 devices.

**What it remembers.** Mercury stores each claim about you as a belief. A belief has evidence, a confidence that fades unless the belief is seen again, and a status: candidate, held, confirmed, contested, retired or forgotten. Something you state outright outranks something Mercury infers. Mercury says it never infers health, religion, politics, sexuality or personality type, and never stores credentials. You can see and edit beliefs with `/memory` commands and an editable `owner.md` file ([Mercury 1.4.1 notes](https://mercuryagent.sh/docs/releases/1.4.1)). We think this is the most specific memory design in this list, and the one to check if you want to know what your agent believes about you.

**What it can do.** Scheduled work is covered in the [built-in tools reference](https://mercuryagent.sh/docs/reference/built-in-tools) and the [web dashboard guide](https://mercuryagent.sh/docs/integrations/web-dashboard), and [sub-agents](https://mercuryagent.sh/docs/integrations/sub-agents) have their own page. Mercury supports several model providers, including local Ollama. Computer control comes from [Optimus](https://mercuryagent.sh/docs/integrations/optimus), a plugin that controls desktop apps. On Linux Wayland it reaches only X11 and XWayland apps, and on Windows it cannot control admin windows. These are the project's own claims, and we have not tested them. The [WhatsApp plugin](https://mercuryagent.sh/docs/integrations/whatsapp) uses an unofficial protocol, and the release notes warn that a number can be restricted.

**Best for and where it falls short.** Best for a persistent personal agent you control. It is young, its desktop app is not code-signed, and the computer-control plugin is unverified. Plugins run out of process with checksum-verified catalog entries and rollback, which helps, but you still have to trust what you install.

## OpenClaw

**What it is.** OpenClaw is an open-source agent with a self-hosted Gateway. The project describes itself as non-profit stewarded and does not sell a paid tier. You can see the official site at [openclaw.ai](https://openclaw.ai).

**Where it runs.** On a machine you run. The Gateway is the process that holds your agent, and you manage its install, updates and infrastructure.

**What it remembers.** Memory is Markdown files in the agent workspace. Daily notes go in `memory/YYYY-MM-DD.md`, and curated long-term notes go in `MEMORY.md`, which loads only in main or private sessions. Memory files persist until you delete them. Before compaction, OpenClaw runs a silent memory flush that reminds the model to write durable notes first. Semantic search is optional and can use OpenAI, Gemini, Ollama, a local model or other providers. The documentation also says that memory sometimes gets forgotten, and the fix is to ask the bot to write the fact to memory.

**What it can do.** Its channels include chat apps such as Telegram, Discord and Slack. It runs per-agent sandboxes, and each agent can have its own sandbox and tool settings. We did not verify its scheduling or browser features for this post.

**Permissions and sandboxing.** Sandboxing is off by default. When enabled, the Gateway stays on the host and only tool execution moves into a Docker, Podman, SSH or OpenShell sandbox. Filesystem and process access is limited, and tool allow and deny rules still apply first. The documentation calls this "not a perfect security boundary", and it provides an escape hatch, `tools.elevated`, that runs `exec` outside the sandbox. Read that setting before you enable anything.

**Best for and where it falls short.** Best for people who want a highly configurable, self-hosted agent and are comfortable managing the infrastructure themselves. Expect setup work, and expect to write your own security policy.

## Manus

**What it is.** Manus is a cloud agent for research, reports, slides, websites and multi-step tasks. It is a commercial product. The official site is [manus.im](https://manus.im).

**Where it runs.** In Manus's cloud. You use it through the web. Its tasks run on Manus's infrastructure, not on your machine.

**What it remembers.** Project and task context. We do not describe Manus as a general persistent personal-memory system, because we found no official documentation that says it is one. Context lives with projects and tasks.

**What it can do.** Research on any topic, slide generation, website deployment on paid plans, and Wide Research for high-volume parallel work. Concurrency is one task on Free and 20 on Pro and Team. Scheduled automations are 2 on Free and 20 on Pro and Team, according to its [Help Center](https://help.manus.im/en/articles/11711111-what-is-the-current-membership-pricing-for-manus). Its live pricing page loaded empty when we fetched it, so the prices below come from the Help Center article.

**Pricing.** Free is $0 with 300 daily refresh credits. Pro starts at $20 a month with 4,000 monthly credits. A higher Pro tier starts at $40 a month with 8,000 credits and a 7-day free trial. Team starts at $20 per seat a month and adds SSO, team usage analytics and access control. Annual billing saves 17 per cent.

**Best for and where it falls short.** Best for cloud execution and finished deliverables without local setup. Your work runs on someone else's infrastructure, and the memory is project context rather than a personal profile.

## Gemini agent for work

**What it is.** Google's Gemini agent for work, announced 8 October 2026, is a single agent for knowledge work, questions, content and code. It is an enterprise product. Google's consumer [Gemini Agent](https://blog.google/products-and-platforms/products/gemini/gemini-3-gemini-app/) is a separate, experimental feature, and this section does not cover it. Google's Gemini products are at [gemini.google.com](https://gemini.google.com).

**Where it runs.** Across web, iOS and Android, Windows and Mac desktops, the command line, Google Workspace, Microsoft 365 and Slack. Its execution runs in the cloud, so work keeps going after you close your laptop. Google says availability depends on rollout.

**What it remembers.** Four memory types: session memory for the task in front of it, semantic memory built from documents and people, procedural memory for how a job gets done, and episodic memory of past work. Google says one personalization graph follows you across devices and channels.

**What it can do.** It can plan work, use skills and tools, and connect to Confluence, Microsoft Office, Teams, Slack, Git, Jira, Salesforce, ServiceNow and databases such as BigQuery and Snowflake. It can also connect to MCP servers. It can schedule tasks, respond to events, and create sub-agents or coworker agents with their own identities. Model choice is built in: Gemini routes each job to a model it judges best, and the announcement names Claude models from Anthropic among them.

**Permissions and sandboxing.** Google describes identity and policy management, authorization and permission controls, secure sandboxing, network gateways and real-time spend caps. We did not find a pricing figure in the announcement, so we leave price blank.

**Best for and where it falls short.** Best for organizations deeply invested in Google Workspace. It is an enterprise offering, so the buyer is an organization, not a single person. Ask about rollout timing and price before you plan around it.

## Devin

**What it is.** Devin is an autonomous software engineering agent from Cognition. It is built for engineering tasks, not general office work. The official site is [devin.ai](https://devin.ai).

**Where it runs.** In Cognition's cloud. Each task gets its own sandboxed virtual machine with a shell, a code editor and a browser. Cognition also offers [Devin Desktop](https://devin.ai/desktop) and a [Devin CLI](https://devin.ai/cli), and ships [Devin Review](https://devin.ai/review), a tool for reviewing pull requests.

**What it remembers.** We did not find a verified description of Devin's memory across tasks, so we leave this blank.

**What it can do.** It plans a task, works in its sandbox, runs tests and opens a pull request. Cognition documents parallel cloud agents for teams. Third-party guides describe its best fit as well-scoped, repetitive work such as migrations, framework upgrades and CI failure triage. Cognition publishes its own benchmark figures on its [CLI page](https://devin.ai/cli) and in its [FrontierCode material](https://devin.ai/ja/blog/frontier-code-2.0). This post does not quote any of those numbers, and we did not verify them.

**Pricing.** Cognition's [pricing page](https://devin.ai/pricing) lists Free, Pro, Max, Teams and Enterprise plans. The figures we give are Pro at $20 a month, Max at $200 a month, and Teams at $80 a month plus $40 per seat, with Enterprise on request. We have not yet re-checked these numbers against that page, and Cognition has changed its pricing more than once, so check it before you rely on them.

**Best for and where it falls short.** Best for teams that want a delegated engineer for well-defined tickets and can review the pull requests it opens. It is a weaker fit for ambiguous feature design or fast prototyping, where a tight human feedback loop matters more. Every pull request still needs human review before merge.

## Claude Cowork

**What it is.** Claude Cowork is Anthropic's agent inside the Claude app, built for longer tasks that run beyond a normal chat. It works on your tasks as a collaborator rather than a single question-and-answer exchange. You can find it on the official site at [claude.com](https://claude.com).

**Where it runs.** On desktop for all paid plans (Pro, Max, Ultra, Team and Enterprise). On web and mobile it is available on Pro, Max, Ultra and Team. Availability depends on plan and surface.

**What it remembers.** We did not verify how Cowork stores memory or project context across sessions, so we leave this blank.

**What it can do.** Its help center describes long-running tasks that are not cut short by conversation timeouts or context limits, and [scheduled recurring tasks](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork). We did not check how it reaches local files, apps or connectors in detail, so we do not describe those here.

**Pricing.** It is included with the paid Claude plans listed above. We did not verify the plan prices for this post.

**Best for and where it falls short.** Best for people who already use Claude and want recurring or long-running work without building their own setup. Its permission model and integrations are the parts to check before you rely on it for anything sensitive.

## Comet

**What it is.** Comet is a web browser from Perplexity with an AI assistant built in. It is a Chromium-compatible browser, so it is closer to a browser than a separate agent service. The official page is [perplexity.ai/comet](https://www.perplexity.ai/comet).

**Where it runs.** On your desktop, as a browser you install. Perplexity's help material describes it as a browser that works with your open tabs and apps, though we did not check every detail of that.

**What it remembers.** We did not verify Comet's memory behavior, so we leave this blank.

**What it can do.** Perplexity's getting-started material lists tasks such as [summarizing videos](https://www.perplexity.ai/comet/resources/videos/comet-summarization), and its [assistant panel guide](https://www.perplexity.ai/help-center/comet/en/articles/11734688-assistant-panel) covers summaries, actions and working across tabs. Perplexity's [March 2026 changelog](https://www.perplexity.ai/changelog/what-we-shipped---march-13-2026) documents the tab-group redesign. For organizations, Perplexity describes centralized policies and domain-specific agent access controls, which admins can set. We did not check whether it runs tasks in the background or on a schedule.

**Pricing.** We did not verify Comet's pricing. Perplexity's paid subscription plans are separate from the browser, and we did not confirm which plan, if any, Comet requires.

**Best for and where it falls short.** Best for research and browsing-heavy work where you want the assistant inside the browser you already use. Because it acts in your browser, check which sites and accounts it can reach before you enable it, and do not assume it is isolated from your logins.

## Which one fits

- **Already use Grok and want a cloud agent with no local setup?** Grok Bot, after you check its pricing and data terms with xAI.
- **Already pay for ChatGPT and work mostly with files and apps?** ChatGPT Work.
- **Want memory you can read and correct, on your own machine?** Mercury.
- **Want to run and inspect the infrastructure yourself?** OpenClaw. Leave the sandbox settings for last, and read them first.
- **Want finished deliverables from a cloud service?** Manus.
- **Work mostly inside Google Workspace, with an admin who can set policy?** Gemini agent for work.
- **Need a delegated engineer for well-scoped tickets?** Devin, with human review of every pull request.
- **Already use Claude and want recurring or long-running work?** Claude Cowork.
- **Do most of your work in a browser and want the assistant there?** Comet, after you check what it can reach.

Whatever you choose, check the sandbox and permission settings before you give any agent shell access, and do not assume a cloud browser can see your logins.

## Sources and references

**Grok**
- [Grok](https://grok.com) (xAI)
- [Grok Bot](https://x.ai/bot) (xAI)
- [Grok documentation](https://docs.x.ai/grok/overview) (xAI)
- [xAI pricing](https://x.ai/pricing)
- [Codersera: Grok Bot complete guide (2026)](https://codersera.com/blog/grok-bot-complete-guide-2026/) (third-party)
- [Unite.AI: xAI adds cross-session memory to Grok Build](https://www.unite.ai/xai-adds-cross-session-memory-to-grok-build-coding-agent) (third-party)

**ChatGPT Work**
- [ChatGPT Work and Codex help](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex) (OpenAI)
- [Using the cloud browser in ChatGPT](https://help.openai.com/en/articles/20001280-using-cloud-browser-in-chatgpt) (OpenAI)
- [OpenAI Learn: pricing and plans](https://learn.chatgpt.com/docs/pricing)
- [ChatGPT](https://chatgpt.com) (OpenAI)
- [Projects in ChatGPT](https://help.openai.com/en/articles/10169521-projects-in-chatgpt) (OpenAI)

**Mercury**
- [Mercury 1.5.0 release notes](https://mercuryagent.sh/docs/releases/1.5.0)
- [Mercury 1.4.1 release notes](https://mercuryagent.sh/docs/releases/1.4.1)
- [Mercury](https://mercuryagent.sh) (official site)
- [Mercury repository](https://github.com/cosmicstack-labs/mercury-agent)
- [Built-in tools reference](https://mercuryagent.sh/docs/reference/built-in-tools)
- [Web dashboard](https://mercuryagent.sh/docs/integrations/web-dashboard)
- [Sub-agents](https://mercuryagent.sh/docs/integrations/sub-agents)
- [Optimus plugin](https://mercuryagent.sh/docs/integrations/optimus)
- [WhatsApp plugin](https://mercuryagent.sh/docs/integrations/whatsapp)

**OpenClaw**
- [OpenClaw](https://openclaw.ai) (official site)
- [Sandboxing and memory FAQ](https://docs.openclaw.ai/help/faq/sandboxing-and-memory)
- [Gateway sandboxing](https://docs.openclaw.ai/gateway/sandboxing)

**Manus**
- [Manus](https://manus.im) (official site)
- [Manus membership pricing and automation limits](https://help.manus.im/en/articles/11711111-what-is-the-current-membership-pricing-for-manus) (Manus Help Center)

**Gemini agent for work**
- [Welcome to Gemini at Work (Google Cloud, 2026)](https://cloud.google.com/blog/products/ai-machine-learning/welcome-to-gemini-at-work-2026)
- [Gemini](https://gemini.google.com) (Google)
- [Gemini 3 in the Gemini app (Google Blog)](https://blog.google/products-and-platforms/products/gemini/gemini-3-gemini-app/) (consumer Gemini Agent)

**Devin**
- [Devin](https://devin.ai/) (Cognition)
- [Devin pricing](https://devin.ai/pricing) (Cognition)
- [Devin Desktop](https://devin.ai/desktop) (Cognition)
- [Devin CLI](https://devin.ai/cli) (Cognition)
- [Devin Review](https://devin.ai/review) (Cognition)
- [FrontierCode 2.0 (Cognition blog)](https://devin.ai/ja/blog/frontier-code-2.0) (Cognition)
- [Layer3 Labs: Devin AI explained](https://www.layer3labs.io/guides/devin-ai-explained) (third-party)

**Claude Cowork**
- [Get started with Claude Cowork](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork) (Anthropic)
- [Let Claude use your computer in Cowork](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork) (Anthropic)
- [Claude](https://claude.com) (Anthropic)
- [Claude Cowork](https://claude.com/product/cowork) (Anthropic)
- [Schedule recurring tasks in Claude Cowork](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork) (Anthropic)

**Comet**
- [Perplexity Comet](https://www.perplexity.ai/comet) (Perplexity)
- [Comet assistant panel](https://www.perplexity.ai/help-center/comet/en/articles/11734688-assistant-panel) (Perplexity)
- [Comet video summarization](https://www.perplexity.ai/comet/resources/videos/comet-summarization) (Perplexity)
- [What we shipped, March 13, 2026](https://www.perplexity.ai/changelog/what-we-shipped---march-13-2026) (Perplexity changelog)
- [Which Perplexity subscription plan is right for you](https://www.perplexity.ai/help-center/en/articles/11187416-which-perplexity-subscription-plan-is-right-for-you) (Perplexity)
- [Perplexity enterprise pricing](https://www.perplexity.ai/enterprise/pricing) (Perplexity)
