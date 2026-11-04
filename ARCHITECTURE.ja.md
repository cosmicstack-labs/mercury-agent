# Mercury — アーキテクチャ

> 生きたドキュメントです。システムの進化に合わせて更新されます。

## 概要

Mercury は、魂（soul）に駆動され、トークン効率に優れた、24 時間 365 日稼働する AI エージェントです。単なるチャットボットではなく、**オーケストレーター**です。ファイルの読み書き、コマンドの実行、複数ステップのエージェント型ワークフローを実行でき、そのすべてが厳格なパーミッションシステムによって管理されます。チャネル（CLI、Telegram、将来的には Signal、Discord、Slack）を介してやり取りし、永続的なメモリを保持します。

## 人間とのアナロジー

| Mercury の概念 | 人間に例えると | ファイル/モジュール |
|---|---|---|
| soul.md | 心臓 | `soul/soul.md` |
| persona.md | 顔 | `soul/persona.md` |
| taste.md | 味覚 | `soul/taste.md` |
| heartbeat.md | 呼吸 | `soul/heartbeat.md` |
| 短期記憶 | ワーキングメモリ | `src/memory/store.ts` |
| エピソード記憶 | 最近の経験 | `src/memory/store.ts` |
| 長期記憶 | 人生の教訓 | `src/memory/store.ts` |
| セカンドブレイン | 構造化された長期的なユーザーモデル | `src/memory/user-memory.ts` + `src/memory/second-brain-db.ts` |
| プロバイダー | 感覚 | `src/providers/` |
| ケイパビリティ | 手と道具 | `src/capabilities/` |
| パーミッション | 境界線 | `src/capabilities/permissions.ts` |
| チャネル | コミュニケーション | `src/channels/` |
| ハートビート/スケジューラー | 概日リズム | `src/core/scheduler.ts` |
| ライフサイクル | 起床/睡眠/思考 | `src/core/lifecycle.ts` |
| サブエージェント | 働き蜂 | `src/core/sub-agent.ts` + `src/core/supervisor.ts` |
| ファイルロック | 協調 | `src/core/file-lock.ts` |
| タスクボード | 共有状態 | `src/core/task-board.ts` |
| リソースマネージャー | キャパシティプランナー | `src/core/resource-manager.ts` |

## ディレクトリ構成

```
src/
├── index.ts              # CLI エントリポイント（commander）
├── channels/             # コミュニケーションインターフェース
│   ├── base.ts           # 抽象チャネル
│   ├── cli.ts            # CLI アダプター（readline + インラインのパーミッション確認）
│   ├── telegram.ts       # Telegram アダプター（grammY）
│   └── registry.ts       # チャネルマネージャー
├── core/                 # チャネルに依存しない頭脳
│   ├── agent.ts          # 複数ステップのエージェントループ（ツール付き generateText）
│   ├── lifecycle.ts      # ステートマシン
│   ├── scheduler.ts      # cron + ハートビート
│   ├── sub-agent.ts      # サブエージェントワーカー（分離されたエージェントループ）
│   ├── supervisor.ts     # サブエージェントスーパーバイザー（生成/停止/オーケストレーション）
│   ├── file-lock.ts      # ファイルロックマネージャー（リーダー・ライターロック）
│   ├── task-board.ts      # 共有タスク状態の永続化
│   └── resource-manager.ts # システムリソースの検出
├── capabilities/         # エージェントのツールとパーミッション
│   ├── permissions.ts    # パーミッションマネージャー（読み書きスコープ、シェルのブロックリスト）
│   ├── registry.ts      # すべての AI SDK ツール + スキル/スケジューラーツールを登録
│   ├── filesystem/      # ファイル操作: 読み取り、書き込み、作成、一覧、削除
│   ├── shell/           # ブロックリスト付きのシェル実行
│   ├── skills/          # スキル管理ツール
│   │   ├── install-skill.ts
│   │   ├── list-skills.ts
│   │   └── use-skill.ts
│   └── scheduler/       # スケジューリングツール
│       ├── schedule-task.ts
│       ├── list-tasks.ts
│       └── cancel-task.ts
│   └── subagents/       # サブエージェントツール
│       ├── delegate-task.ts
│       ├── list-agents.ts
│       └── stop-agent.ts
├── memory/               # 永続化レイヤー
│   ├── store.ts          # 短期/長期/エピソード記憶
│   ├── second-brain-db.ts # SQLite ストレージエンジン（FTS5）
│   └── user-memory.ts    # セカンドブレイン: 自律的な構造化メモリ
├── providers/            # LLM API
│   ├── base.ts           # 抽象プロバイダー + getModelInstance()
│   ├── openai-compat.ts
│   ├── anthropic.ts
│   └── registry.ts
├── soul/                 # 意識
│   └── identity.ts       # soul/persona/taste のローダー + ガードレール
├── skills/               # モジュール式の能力（Agent Skills 仕様）
│   ├── types.ts          # SkillMeta、SkillDiscovery、Skill 型
│   ├── loader.ts         # SKILL.md パーサー、段階的開示
│   └── index.ts          # バレルエクスポート
├── types/                # 型定義
└── utils/                # 設定、ロガー、トークン
```

## エージェントループ

Mercury は Vercel AI SDK の複数ステップ対応 `generateText()` をツールと組み合わせて使用します。

```
ユーザーのメッセージ → エージェントがシステムプロンプトを読み込む（soul + ガードレール + persona）
  → エージェントが generateText({ tools, maxSteps: 10 }) を呼び出す
    → LLM が判断: テキストで応答する か ツールを呼び出す
      → ツールが呼び出された場合:
        → パーミッションチェック（ファイルシステムのスコープ / シェルのブロックリスト）
        → 許可された場合: ツールを実行し、結果を LLM に返す
        → 拒否された場合: LLM は拒否メッセージを受け取り、アプローチを調整する
        → LLM が続行（次のステップ）— さらにツールを呼ぶか、応答する
      → テキストの場合: 最終応答をユーザーに返す
  → エージェントがチャネル経由で最終応答を送信
```

## パーミッションシステム

### ファイルシステムのパーミッション（フォルダ単位のスコープ）

- スコープのないパス = **アクセス不可**。ユーザーへの確認が必要
- ユーザーは `y`（今回のみ）、`always`（マニフェストに保存）、`n`（拒否）で許可を与えられます
- マニフェストは `~/.mercury/permissions.yaml` に保存されます
- いつでも編集可能 — Mercury がこれを迂回することはありません

### シェルのパーミッション

- **ブロック**（決して実行されない）: `sudo *`、`rm -rf /`、`mkfs`、`dd if=`、フォーク爆弾、`shutdown`、`reboot`
- **自動承認**（確認なし）: `ls`、`cat`、`pwd`、`git status/diff/log`、`node`、`npm run/test`
- **承認が必要**: `npm publish`、`git push`、`docker`、`rm -r`、`chmod`、パイプされた `curl | sh`
- コマンドは CWD と承認済みのフォルダスコープ内に制限されます

### インラインのパーミッション UX

Mercury が持っていないスコープを必要とする場合:
```
  ⚠ Mercury needs write access to ~/projects/myapp. Allow? (y/n/always):
  > always
  [Scope saved to ~/.mercury/permissions.yaml]
```

## ツール

| ツール | 説明 | パーミッションチェック |
|---|---|---|
| `read_file` | ファイルの内容を読み取る | パスに対する読み取りスコープ |
| `write_file` | 既存ファイルに書き込む | パスに対する書き込みスコープ |
| `create_file` | 新規ファイル + ディレクトリを作成 | 親ディレクトリに対する書き込みスコープ |
| `list_dir` | ディレクトリの内容を一覧表示 | パスに対する読み取りスコープ |
| `delete_file` | ファイルを削除 | 書き込みスコープ、常に確認あり |
| `run_command` | シェルコマンドを実行 | ブロックリスト + 承認リスト + スコープ |
| `install_skill` | コンテンツまたは URL からスキルをインストール | 制限なし |
| `list_skills` | インストール済みスキルを一覧表示 | 制限なし |
| `use_skill` | スキルの指示を読み込んで実行 | 制限なし |
| `schedule_task` | 定期実行の cron タスクを登録 | cron 式を検証 |
| `list_scheduled_tasks` | スケジュール済みタスクを一覧表示 | 制限なし |
| `cancel_scheduled_task` | スケジュール済みタスクをキャンセル | 制限なし |

## エージェントのライフサイクル

```
unborn → birthing → onboarding → idle ⇄ thinking → responding → idle
                                                          ↓
                                            idle → sleeping → awakening → idle
```

## ランタイムデータの保存場所

すべてのランタイムデータは（プロジェクトディレクトリではなく）`~/.mercury/` に置かれます。

| 内容 | 場所 |
|---|---|
| 設定 | `~/.mercury/mercury.yaml` |
| soul ファイル | `~/.mercury/soul/*.md` |
| メモリ | `~/.mercury/memory/` |
| スキル | `~/.mercury/skills/` |
| スケジュール | `~/.mercury/schedules.yaml` |
| パーミッション | `~/.mercury/permissions.yaml` |

## トークン予算

- システムプロンプト（soul + ガードレール + persona）: リクエストあたり約 500 トークン
- 短期コンテキスト: 直近 10 メッセージ
- 長期的な事実: キーワードマッチで約 3 件を注入
- セカンドブレイン: `retrieveRelevant()` で関連するユーザーメモリを注入（約 900 文字）
- 1 日のデフォルト上限: 1,000,000 トークン

## セカンドブレイン

Mercury のセカンドブレインは、会話から時間をかけて学習する、自律的で永続的なユーザーモデルです。生のチャットログでも、ドキュメントの寄せ集めでもありません。将来の会話で役立つと判断した、コンパクトで構造化されたメモリを保存します。

### 意識と潜在意識

セカンドブレインには 2 つの層があります。

| 層 | 内容 | 仕組み |
|---|---|---|
| **意識（Conscious）** | 会話で積極的に使われるメモリ | FTS5 で検索・スコアリングされ、システムプロンプトに注入される（最大 5 件 / 900 文字） |
| **潜在意識（Subconscious）** | 30 日以上参照されていないメモリ | 保存されているが休眠状態。意識層の検索結果が弱い場合にのみ検索される。強くマッチすると意識層に呼び戻される。 |

何も恒久的に削除されることはありません（ユーザーが明示的に消去した場合や、競合解決で置き換えられた場合を除く）。メモリは **意識 → 潜在意識**（30 日間参照なし）、**潜在意識 → 意識**（強い想起マッチ）と行き来します。

### 学習の仕組み（バックグラウンドで、目に見えない形で）

自明でない会話ごとに:
1. Mercury は通常どおりユーザーに応答します。
2. 応答の送信後、バックグラウンドの `extractMemory()` 呼び出しが、別の LLM 呼び出し（約 800 トークン）を使って、型付きのメモリ候補（preference、goal、project など）を 0〜3 件抽出します。
3. 各候補は `UserMemoryStore.remember()` を通り、次の処理を受けます:
   - 重複率が 74% 以上なら既存メモリとマージ（根拠を強化）
   - 競合を自動解決（確信度が高いほうが勝ち、同じ確信度なら新しいほうが勝ち）
   - 自動で階層分け: identity/preference → durable、goal/project → active
   - 弱いメモリは低い確信度で保存され、自然に減衰していく
4. 各ハートビートで、Mercury は統合（プロフィール/アクティブなサマリーの再合成、リフレクションの生成）と剪定を行います:
   - 裏付けとなる観測が 3 回以上あれば active → durable に昇格
   - 古くなったメモリ（30 日以上参照なし）を意識から潜在意識へ移動
   - 明示的に破棄されたメモリ（ユーザーの Clear All、競合による置き換え）のみ完全削除

### 潜在意識からの想起

`retrieveRelevant()` がプロンプトに注入するメモリを検索するとき:

1. **パス 1**: 意識層のメモリ（scope = active/durable）に対して FTS5 検索
2. 意識層のスコアリング式で、意識層の結果を**スコアリングして順位付け**
3. **チェック**: スコアが 0.5 を超える結果が 3 件未満（意識層のマッチが弱い）なら、パス 2 に進む
4. **パス 2**: 潜在意識層のメモリ（scope = subconscious）に対して FTS5 検索
5. 潜在意識層のスコアリング式（キーワードマッチの重みが大きい）で、潜在意識層の結果を**スコアリングして順位付け**
6. **昇格**: 選ばれた潜在意識層のメモリは意識層に戻される（`inferScope` によって scope が active または durable に設定される）
7. 意識層のメモリと呼び戻された潜在意識層のメモリは、同じ 5 枠 / 900 文字の予算を共有する

### 保存しないもの

- 挨拶、雑談、つなぎの言葉
- シグナルの弱い一回限りの詳細（確信度の最低値 0.55 未満）
- アシスタントによる憶測

### `/memory` コマンド

```
/memory        → 矢印キーメニューを開く（CLI）または概要を送信（Telegram）

メニュー:
  Overview          — 意識層のメモリ、潜在意識層のメモリ、種類別の内訳、学習状態
  Recent            — 直近 10 件の意識層のメモリ（種類 + 要約 + 確信度 + scope）
  Search            — すべてのメモリ（意識 + 潜在意識）に対する全文検索
  Pause Learning    — 切り替え: 新しいメモリの保存を停止/再開
  Clear All         — 確認のうえ、すべてのメモリを消去
  Back
```

### ユーザーによる操作

セカンドブレインは学習も管理も自律的に行います。ユーザーができる操作は次のものだけです:
- 学習の**一時停止/再開**（センシティブな会話のため）
- すべてのメモリの**消去**（最初からやり直す）
- 概要、最近のメモリ、検索による**観察**

レビューキューはありません。手動でのピン留めも、手動での競合解決も、手動での編集もありません。

## チャネル

### CLI
- readline ベースで、インラインのパーミッション確認付き
- `mercury start` または単に `mercury`

### Telegram
- grammY フレームワーク + ストリーミング用の @grammyjs/stream
- 処理中は入力中インジケーターを表示
- ハートビートによる能動的なメッセージ送信
- `TELEGRAM_BOT_TOKEN` を .env または mercury.yaml に設定

## スキルシステム

Mercury は Agent Skills 仕様をサポートしています。スキルはモジュール式でインストール可能な指示セットで、コードを変更せずに Mercury の能力を拡張します。

### スキルの形式

各スキルは `~/.mercury/skills/` 配下のディレクトリで、`SKILL.md` を含みます:

```
~/.mercury/skills/
├── daily-digest/
│   └── SKILL.md       # 必須: YAML フロントマター + Markdown の指示
├── code-review/
│   ├── SKILL.md
│   ├── scripts/       # 任意: 実行可能なスクリプト
│   └── references/    # 任意: 参考ドキュメント
└── _template/
    └── SKILL.md       # 新規スキル用に用意されたテンプレート
```

### SKILL.md の構造

```markdown
---
name: daily-digest
description: Send a daily summary of activity
version: 0.1.0
allowed-tools:
  - read_file
  - list_dir
  - run_command
---

# Daily Digest

Instructions for Mercury to follow when this skill is invoked...
```

### 段階的開示

- **起動時**: スキル名と説明のみを読み込む（トークン効率が良い）
- **呼び出し時**: `use_skill` ツールでスキルの完全な指示をオンデマンドで読み込む
- これにより、スキルを利用可能にしつつシステムプロンプトを小さく保てます

### スキルツール

- `install_skill`: Markdown コンテンツまたは URL からインストール
- `list_skills`: インストール済みのスキルをすべて表示
- `use_skill`: スキルの指示を読み込み、エージェントのコンテキストに取り込んで実行

## スケジューラー

Mercury は cron 式を使って定期タスクをスケジュールできます。タスクは `~/.mercury/schedules.yaml` に永続化され、起動時に復元されます。

### スケジュール済みタスクのフィールド

| フィールド | 説明 |
|---|---|
| `id` | タスクの一意な識別子 |
| `cron` | 標準的な 5 フィールドの cron 式 |
| `description` | 人間が読める説明 |
| `prompt` | タスク発火時にエージェントへ送るテキストプロンプト |
| `skill_name` | 任意: タスク発火時に呼び出すスキル |
| `createdAt` | ISO タイムスタンプ |

### タスクの実行方法

スケジュール済みタスクが発火すると:
1. `skill_name` が設定されていれば、Mercury は `use_skill` でそのスキルを呼び出すよう促されます
2. `prompt` が設定されていれば、Mercury はそれを内部（チャネル外）メッセージとして処理します
3. 内部メッセージはチャネル上に目に見える応答を生成しません — エージェントループ内で静かに実行されます

### スケジューラーツール

- `schedule_task`: prompt または skill_name を指定して cron タスクを作成
- `list_scheduled_tasks`: スケジュール済みのタスクをすべて表示
- `cancel_scheduled_task`: スケジュール済みのタスクを削除

## サブエージェント

Mercury はサブエージェントをサポートしています。サブエージェントは、同じ Node.js プロセス内で非同期コルーチンとして動作する独立したワーカーです。サブエージェントにより、Mercury はメインエージェントをブロックせずに複数のタスクを並行して処理できます。

### なぜサブエージェントなのか？

- **ノンブロッキング**: サブエージェントが作業している間も、メインエージェントは新しいメッセージに対応できます
- **リソースを考慮**: 最大同時実行数は CPU コア数と利用可能な RAM から自動検出されます
- **協調的**: ファイルロックにより、エージェント間で書き込みが競合するのを防ぎます
- **制御可能**: `/agents`、`/halt`、`/stop`、`/reset` コマンドで、ユーザーが完全に制御できます
- **ノンブロッキング**: サブエージェントはバックグラウンドで動作し、メインエージェントは新しいメッセージに応答し続けます
- **可視化**: 進捗通知（`🔄 Agent a1: Using: read_file`）と完了メッセージ（`✅ Agent a1 completed (8.2s)`）がユーザーのチャネルに送信されます
- **ファストパスコマンド**: `/agents`、`/halt`、`/spotify`、`/code` などのスラッシュコマンドは、メインエージェントがビジーな間でも即座に処理されます

### アーキテクチャ

```
ユーザーのメッセージ → メインエージェント → 判断:
  ├─ すぐ返せる応答 → その場で処理し、直接応答
  └─ 重いタスク → delegate_task ツール → サブエージェントを生成（ノンブロッキング）
       → メインエージェントの応答: "🤖 Agent a1 is working on..."
       → メインエージェントは次のメッセージに対応可能なまま
       → サブエージェントの進捗: "🔄 Agent a1: Using: read_file, edit_file"
       → サブエージェントの完了: "✅ Agent a1 completed (8.2s): result..."
       → ユーザーはいつでも /agents で状態を確認できる
```

### コンポーネント概要

| コンポーネント | ファイル | 役割 |
|---|---|---|
| SubAgent | `src/core/sub-agent.ts` | ワーカー: 中断、ファイルロック、進捗報告を備えた分離されたエージェントループ |
| SubAgentSupervisor | `src/core/supervisor.ts` | オーケストレーター: 生成/停止/キューイング、リソース管理 |
| FileLockManager | `src/core/file-lock.ts` | 読み書きロック: 複数のリーダー、排他的なライター、自動解放 |
| TaskBoard | `src/core/task-board.ts` | 共有状態: タスクの状態と進捗をディスクに永続化 |
| ResourceManager | `src/core/resource-manager.ts` | システム検出: CPU コア数、RAM、最大同時実行数の計算式 |

### リソース制限

サブエージェントの最大同時実行数のデフォルト = `clamp(1, cpus - 1, floor(availableRAM_GB / 2))`

`/agents set max <n>` または環境変数 `SUBAGENTS_MAX_CONCURRENT` で上書きできます。

### ライフサイクル

```
unborn → birthing → onboarding → idle ⇄ thinking → responding → idle
                                                  ↓
                                          idle → delegating → idle
                                          idle → sleeping → awakening → idle
```

`delegating` 状態は、メインエージェントがサブエージェントにタスクを引き渡している状態を表します。

### サブエージェントツール

| ツール | 説明 |
|---|---|
| `delegate_task` | サブエージェントワーカーにタスクを委任 |
| `list_agents` | 稼働中のサブエージェントとその状態を一覧表示 |
| `stop_agent` | サブエージェント（またはすべて）を停止 |

### ユーザーコマンド

| コマンド | 説明 |
|---|---|
| `/agents` | すべてのサブエージェントを一覧表示（状態、タスク、進捗） |
| `/agents stop <id>` | 特定のサブエージェントを停止 |
| `/agents stop all` | すべてのサブエージェントを停止 |
| `/agents pause <id>` | 現在のステップの完了後にサブエージェントを一時停止 |
| `/agents resume <id>` | 一時停止中のサブエージェントを再開 |
| `/agents config` | リソース割り当てを表示 |
| `/agents set max <n>` | 最大同時実行数を上書き |
| `/halt` | すべてのエージェントを緊急停止 + キューをクリア |
| `/stop` | すべてのエージェントを停止 + キューをクリア + ロックを解放 + タスクボードをクリア |
| `/reset` | 完全リセット: すべて停止 + コンテキストをクリア（確認が必要） |

### プログラミングモード

Mercury には、IDE レベルのコーディングタスク向けに最適化するプログラミングモード（`/code plan` で有効化）が組み込まれています。2 つの状態で動作します。

**プランモード**（`/code plan`）: Mercury はコードベースを探索し、問題を分析し、`ask_user` を使って複数のアプローチを提示し、ステップごとの実装計画をまとめます — コードは書きません。

**実行モード**（`/code execute`）: Mercury は承認された計画をステップごとに実装し、変更後にビルド/テストを実行し、チェックポイントでコミットし、独立したサブタスクをサブエージェントに委任します。

| コマンド | 説明 |
|---|---|
| `/code` | 現在のプログラミングモードの状態を表示 |
| `/code plan` | プランモードに切り替え（分析し、選択肢を提示。コーディングはしない） |
| `/code execute` | 実行モードに切り替え（計画をステップごとに実装） |
| `/code off` | プログラミングモードを終了 |
| `/code toggle` | 循環切り替え: off → plan → execute → off |

`ask_user` ツールにより、Mercury は選択肢（アプローチ、ライブラリ、戦略）を CLI では矢印キーメニュー、Telegram ではインラインキーボードで提示できます。

### ファイルロックのセマンティクス

- **読み取りロック**: 複数のサブエージェントが同じファイルを同時に読み取れます
- **書き込みロック**: 排他的 — 一度に 1 つのエージェントだけがファイルに書き込めます
- **自動解放**: サブエージェントの終了時（完了、失敗、停止）にロックが解放されます
- **デッドロック検出**: スーパーバイザーがエージェント間の循環待ちを検出します

### タスクボードの永続化

サブエージェントのタスク状態はすべて `~/.mercury/memory/task-board.json` に永続化され、プロセスの再起動後も保持されます。

### 設定

```yaml
subagents:
  enabled: true        # サブエージェントシステムの有効/無効
  maxConcurrent: 0      # 0 = CPU/RAM から自動検出、>0 = 手動で上書き
  mode: auto            # auto = 自動検出、manual = maxConcurrent の値を使用
```

環境変数による上書き: `SUBAGENTS_ENABLED`、`SUBAGENTS_MAX_CONCURRENT`、`SUBAGENTS_MODE`
## Spotify 連携

Mercury は Spotify Web API を介して、ユーザーの Spotify 再生をリモートで操作できます。音楽はユーザー自身のデバイス（スマートフォン、Web、デスクトップ、テレビ、スピーカー）で再生され、ローカルでは再生されません。

### セットアップ

1. https://developer.spotify.com/dashboard で Spotify アプリを作成します
2. リダイレクト URI を `http://127.0.0.1:8888/callback` に設定します
3. `.env` に `SPOTIFY_CLIENT_ID` と `SPOTIFY_CLIENT_SECRET` を設定します
4. Mercury で `/spotify auth` を実行します — OAuth 認可のためにブラウザが開きます
5. トークンは `~/.mercury/mercury.yaml` に保存され、自動で更新されます

### デバイスの選択

Spotify のデバイス API は、ユーザーがログインしているアクティブなデバイスをすべて一覧表示します。Mercury は再生/一時停止/スキップのコマンドをユーザーが選択したデバイスに送信します — ローカルで音声を再生することはありません。

### DJ スキル

`spotify` スキル（`/skills/spotify/SKILL.md`）は DJ モードを有効にします:
- 気分/ジャンル/アクティビティに基づいて Spotify を検索
- `ask_user` で選択肢を提示（CLI では矢印キー、Telegram ではインラインボタン）
- 再生、キュー、お気に入り、プレイリストを管理
- ユーザーの好みからキュレーションしたプレイリストを作成

### プレイヤー UI

**CLI**: `/spotify player` で対話式の矢印キーメニューが開きます:
```
  ▶  Play / Resume
  ⏸  Pause
  ⏭  Next Track
  ⏮  Previous Track
  🔀 Toggle Shuffle
  🔁 Cycle Repeat
  🎵 Now Playing
  📱 Devices
  🔍 Search & Play
  🔊 Set Volume
  📋 Add to Queue
  ❤️  Like Current Track
  ✕  Exit Player
```

**Telegram**: 再生コントロールをインラインキーボードのボタンとして表示します。

### コマンド

| コマンド | 説明 |
|---|---|
| `/spotify` | 接続状態を表示 |
| `/spotify auth` | OAuth フローを開始（ブラウザが開く） |
| `/spotify player` | 対話式プレイヤー（CLI のみ） |
| `/spotify devices` | アクティブな Spotify デバイスを一覧表示 |
| `/spotify device <id>` | アクティブなデバイスを設定 |
| `/spotify now` | 再生中のトラックを表示 |

### 設定

```yaml
spotify:
  enabled: true
  clientId: ...
  clientSecret: ...
  redirectUri: http://127.0.0.1:8888/callback
  accessToken: ...
  refreshToken: ...
  expiresAt: ...
  scopes: [...]
  deviceId: ...
```

環境変数による上書き: `SPOTIFY_CLIENT_ID`、`SPOTIFY_CLIENT_SECRET`、`SPOTIFY_REDIRECT_URI`
