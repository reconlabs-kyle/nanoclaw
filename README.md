<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  An AI assistant that runs agents securely in their own containers. Lightweight, built to be easily understood and completely customized for your needs.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="https://docs.nanoclaw.dev">docs</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>&nbsp; • &nbsp;
  <a href="repo-tokens"><img src="repo-tokens/badge.svg" alt="34.9k tokens, 17% of context window" valign="middle"></a>
</p>

---

## 🇰🇷 이 포크에서 추가한 기능 (원본 [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) 대비)

이 리포는 upstream NanoClaw를 개인 어시스턴트로 오래 쓰면서 필요했던 기능들을 얹은 포크입니다. 아래 기능들은 모두 기본 설치에 포함되어 있으며, 별도 설정 없이 동작합니다 (단, Google MCP는 OneCLI 자격증명 연결이 필요합니다).

### 🧠 벡터 기반 장기 기억 시스템

- 그룹 폴더의 마크다운 파일을 **Gemini embedding** 으로 자동 인덱싱하고 sqlite-vec 에 저장합니다.
- 컨테이너 내부에 `mcp__nanoclaw__memory_search` 도구가 노출되어, 에이전트가 과거 대화·노트·결정을 **의미 기반**으로 검색할 수 있습니다 (시간 감쇠 KNN).
- diff 기반 재인덱싱 — 변경된 청크만 다시 임베딩합니다.
- 일일/주간 reflection 크론 직후 자동으로 재인덱싱됩니다.
- `GEMINI_API_KEY` 만 `.env`에 넣으면 즉시 동작합니다.

### 🔒 그룹별 대화 이력의 물리적 격리

- non-main 컨테이너는 자신의 `chat_jid` 에 해당하는 행만 포함된 **읽기전용 SQLite 스냅샷**만 볼 수 있습니다.
- SQL 쿼리에서 `WHERE` 절을 빼먹어도 다른 그룹 대화는 물리적으로 접근 불가능합니다 (파일 자체가 다름).
- `src/message-snapshot.ts` — 컨테이너 spawn 시점마다 해당 그룹용 필터된 DB를 만듭니다.

### 🧑‍🤝‍🧑 멀티 에이전트 / 멀티 봇

- **그룹별 `identity.md`** — 각 그룹 폴더에 `**Name:** 러닝코치` 같은 식으로 페르소나를 지정하면 에이전트가 그 이름으로 동작하고 응답합니다.
- **Telegram 멀티봇** — `TELEGRAM_BOT_TOKEN_<ID>` 형태로 여러 봇을 등록하면 하나의 NanoClaw 인스턴스에서 각기 다른 봇 인격을 운영할 수 있습니다. JID 가 `tg:<botId>:<chatId>` 로 prefix 되어 봇끼리 충돌 없습니다.
- `ChannelFactory` 시그니처가 `Channel | Channel[]` 로 확장되어 채널 하나가 여러 인스턴스를 반환할 수 있습니다.

### 🔑 Google Workspace MCP 통합 (읽기 + 쓰기)

OneCLI 게이트웨이로 자격증명을 관리하는 stub-file 패턴을 사용합니다 — 컨테이너는 실제 토큰을 절대 보지 않습니다.

| MCP 이름 | 패키지 | 커버 범위 |
|---------|-------|-----------|
| `mcp__gmail__*` | `@gongrzhe/server-gmail-autoauth-mcp` | Gmail 읽기/검색/전송/라벨 |
| `mcp__gdrive__*` | `@piotr-agier/google-drive-mcp` | Drive / Docs / Sheets / Slides / Calendar |
| `mcp__gforms__*` | `@pegasusheavy/google-mcp` | Forms 생성/편집 + 응답 조회 |

### ⚡ MCP 서버 prewarm

- Claude Code SDK 는 `query()` 시작 시 MCP 서버를 백그라운드 spawn 하지만 initialize handshake 를 기다리지 않습니다. 첫 턴에서 MCP 도구를 호출하는 cron prompt 는 "MCP servers are still connecting" 으로 실패합니다.
- `container/agent-runner/src/mcp-prewarm.ts` — 미리 handshake 를 돌려 OAuth 자격증명 + dependent 모듈 캐시를 워밍해 경쟁 조건을 회피합니다.

### 💬 보낸 메시지 로깅 + `NO_REPLY` sentinel

- 에이전트의 답변이 `messages.db` 에 역방향 저장되어, 다음 턴 컨텍스트에서 자기 이전 응답을 볼 수 있습니다.
- 출력에 `NO_REPLY` 를 쓰면 formatOutbound 가 빈 문자열로 처리 — 스케줄 태스크가 "이번엔 알림 안 보낸다" 결정할 때 유용합니다.

### 🩹 OneCLI 호환 개선

- Colima/Docker Desktop VM에서 OneCLI SDK 가 `/var/folders/` 에 쓰는 CA 인증서 경로가 접근 불가능한 문제를 `data/onecli-*.pem` 으로 리매핑해서 해결.

---

**이 fork 를 clone 해서 쓰시려면**: 위 기능들은 메인 브랜치에 모두 있습니다. 개인 식별 정보 (그룹별 `CLAUDE.md` 의 특정 페르소나 이름, 사용자별 스케줄 태스크 등) 는 `--skip-worktree` / `.gitignore` 로 제외되어 있으니 fork 받은 뒤 자기 설정으로 덮어쓰시면 됩니다.

---

## Why I Built NanoClaw

[OpenClaw](https://github.com/openclaw/openclaw) is an impressive project, but I wouldn't have been able to sleep if I had given complex software I didn't understand full access to my life. OpenClaw has nearly half a million lines of code, 53 config files, and 70+ dependencies. Its security is at the application level (allowlists, pairing codes) rather than true OS-level isolation. Everything runs in one Node process with shared memory.

NanoClaw provides that same core functionality, but in a codebase small enough to understand: one process and a handful of files. Claude agents run in their own Linux containers with filesystem isolation, not merely behind permission checks.

## Quick Start

```bash
gh repo fork qwibitai/nanoclaw --clone
cd nanoclaw
claude
```

<details>
<summary>Without GitHub CLI</summary>

1. Fork [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) on GitHub (click the Fork button)
2. `git clone https://github.com/<your-username>/nanoclaw.git`
3. `cd nanoclaw`
4. `claude`

</details>

Then run `/setup`. Claude Code handles everything: dependencies, authentication, container setup and service configuration.

> **Note:** Commands prefixed with `/` (like `/setup`, `/add-whatsapp`) are [Claude Code skills](https://code.claude.com/docs/en/skills). Type them inside the `claude` CLI prompt, not in your regular terminal. If you don't have Claude Code installed, get it at [claude.com/product/claude-code](https://claude.com/product/claude-code).

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices. If you want to understand the full NanoClaw codebase, just ask Claude Code to walk you through it.

**Secure by isolation.** Agents run in Linux containers (Apple Container on macOS, or Docker) and they can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** NanoClaw isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, NanoClaw is designed to be bespoke. You make your own fork and have Claude Code modify it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native.**
- No installation wizard; Claude Code guides setup.
- No monitoring dashboard; ask Claude what's happening.
- No debugging tools; describe the problem and Claude fixes it.

**Skills over features.** Instead of adding features (e.g. support for Telegram) to the codebase, contributors submit [claude code skills](https://code.claude.com/docs/en/skills) like `/add-telegram` that transform your fork. You end up with clean code that does exactly what you need.

**Best harness, best model.** NanoClaw runs on the Claude Agent SDK, which means you're running Claude Code directly. Claude Code is highly capable and its coding and problem-solving capabilities allow it to modify and expand NanoClaw and tailor it to each user.

## What It Supports

- **Multi-channel messaging** - Talk to your assistant from WhatsApp, Telegram, Discord, Slack, or Gmail. Add channels with skills like `/add-whatsapp` or `/add-telegram`. Run one or many at the same time.
- **Isolated group context** - Each group has its own `CLAUDE.md` memory, isolated filesystem, and runs in its own container sandbox with only that filesystem mounted to it.
- **Main channel** - Your private channel (self-chat) for admin control; every group is completely isolated
- **Scheduled tasks** - Recurring jobs that run Claude and can message you back
- **Web access** - Search and fetch content from the Web
- **Container isolation** - Agents are sandboxed in Docker (macOS/Linux), [Docker Sandboxes](docs/docker-sandboxes.md) (micro VM isolation), or Apple Container (macOS)
- **Credential security** - Agents never hold raw API keys. Outbound requests route through [OneCLI's Agent Vault](https://github.com/onecli/onecli), which injects credentials at request time and enforces per-agent policies and rate limits.
- **Agent Swarms** - Spin up teams of specialized agents that collaborate on complex tasks
- **Optional integrations** - Add Gmail (`/add-gmail`) and more via skills

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From the main channel (your self-chat), you can manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

NanoClaw doesn't use configuration files. To make changes, just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Claude can safely modify it.

## Contributing

**Don't add features. Add skills.**

If you want to add Telegram support, don't create a PR that adds Telegram to the core codebase. Instead, fork NanoClaw, make the code changes on a branch, and open a PR. We'll create a `skill/telegram` branch from your PR that other users can merge into their fork.

Users then run `/add-telegram` on their fork and get clean code that does exactly what they need, not a bloated system trying to support every use case.

### RFS (Request for Skills)

Skills we'd like to see:

**Communication Channels**
- `/add-signal` - Add Signal as a channel

## Requirements

- macOS, Linux, or Windows (via WSL2)
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)

## Architecture

```
Channels --> SQLite --> Polling loop --> Container (Claude Agent SDK) --> Response
```

Single Node.js process. Channels are added via skills and self-register at startup — the orchestrator connects whichever ones have credentials present. Agents execute in isolated Linux containers with filesystem isolation. Only mounted directories are accessible. Per-group message queue with concurrency control. IPC via filesystem.

For the full architecture details, see the [documentation site](https://docs.nanoclaw.dev/concepts/architecture).

Key files:
- `src/index.ts` - Orchestrator: state, message loop, agent invocation
- `src/channels/registry.ts` - Channel registry (self-registration at startup)
- `src/ipc.ts` - IPC watcher and task processing
- `src/router.ts` - Message formatting and outbound routing
- `src/group-queue.ts` - Per-group queue with global concurrency limit
- `src/container-runner.ts` - Spawns streaming agent containers
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations (messages, groups, sessions, state)
- `groups/*/CLAUDE.md` - Per-group memory

## FAQ

**Why Docker?**

Docker provides cross-platform support (macOS, Linux and even Windows via WSL2) and a mature ecosystem. On macOS, you can optionally switch to Apple Container via `/convert-to-apple-container` for a lighter-weight native runtime. For additional isolation, [Docker Sandboxes](docs/docker-sandboxes.md) run each container inside a micro VM.

**Can I run this on Linux or Windows?**

Yes. Docker is the default runtime and works on macOS, Linux, and Windows (via WSL2). Just run `/setup`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. Credentials never enter the container — outbound API requests route through [OneCLI's Agent Vault](https://github.com/onecli/onecli), which injects authentication at the proxy level and supports rate limits and access policies. You should still review what you're running, but the codebase is small enough that you actually can. See the [security documentation](https://docs.nanoclaw.dev/concepts/security) for the full security model.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize NanoClaw so that the code does exactly what they want, rather than configuring a generic system. If you prefer having config files, you can tell Claude to add them.

**Can I use third-party or open-source models?**

Yes. NanoClaw supports any Claude API-compatible model endpoint. Set these environment variables in your `.env` file:

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

This allows you to use:
- Local models via [Ollama](https://ollama.ai) with an API proxy
- Open-source models hosted on [Together AI](https://together.ai), [Fireworks](https://fireworks.ai), etc.
- Custom model deployments with Anthropic-compatible APIs

Note: The model must support the Anthropic API format for best compatibility.

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies NanoClaw.

**Why isn't the setup working for me?**

If you have issues, during setup, Claude will try to dynamically fix them. If that doesn't work, run `claude`, then run `/debug`. If Claude finds an issue that is likely affecting other users, open a PR to modify the setup SKILL.md.

**What changes will be accepted into the codebase?**

Only security fixes, bug fixes, and clear improvements will be accepted to the base configuration. That's all.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes, or the [full release history](https://docs.nanoclaw.dev/changelog) on the documentation site.

## License

MIT
