# フォーム送信データ運用ガイド（Supabase）

## 1. 目的
`index.html` のフォーム送信データを Supabase に永続保存し、運用者が安全に閲覧できるようにする。

## 2. 実装構成
- フロントエンド: `index.html`
  - 送信先: `POST /api/messages`
  - 失敗時: 指数バックオフで最大3回リトライ
  - それでも失敗した場合: `localStorage` に一時保存し、オンライン復帰時に自動再送
- API: `api/messages.js`
  - 入力値バリデーション
  - Supabase REST API に INSERT
  - 4xx/5xx のレスポンス整理

## 3. Supabase テーブル作成
リポジトリには migration を同梱している。まずは `supabase/migrations/20260307033114_create_form_submissions_table.sql` を適用する。

```bash
supabase db push
```

CLI が利用できない場合は、Supabase SQL Editor で以下を実行:

```sql
create table if not exists public.form_submissions (
  id bigint generated always as identity primary key,
  name text not null,
  email text not null,
  message text not null,
  source text not null default 'mezame-letter',
  user_agent text,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint form_submissions_name_not_blank check (char_length(btrim(name)) > 0),
  constraint form_submissions_email_not_blank check (char_length(btrim(email)) > 0),
  constraint form_submissions_message_not_blank check (char_length(btrim(message)) > 0),
  constraint form_submissions_name_len check (char_length(name) <= 80),
  constraint form_submissions_email_len check (char_length(email) <= 254),
  constraint form_submissions_message_len check (char_length(message) <= 5000),
  constraint form_submissions_user_agent_len check (
    user_agent is null or char_length(user_agent) <= 512
  )
);

create index if not exists form_submissions_submitted_at_idx
  on public.form_submissions (submitted_at desc);

alter table public.form_submissions enable row level security;
```

SQL Editor などで手動適用した場合は migration 履歴も同期する:

```bash
supabase migration repair 20260307033114 --status applied
```

注: 現行APIは `SUPABASE_SERVICE_ROLE_KEY` でサーバー側書き込みを行うため、RLSは有効のままで運用可能。

## 4. 環境変数（Vercel / 実行環境）
- `SUPABASE_URL`: Supabase プロジェクトURL（例: `https://xxxx.supabase.co`）
- `SUPABASE_SERVICE_ROLE_KEY`: service_role キー
- `SUPABASE_MESSAGES_TABLE`: 任意。未指定時は `form_submissions`
- `SUPABASE_SCHEMA`: 任意。未指定時は `public`
- `ALLOWED_ORIGINS`: 任意。カンマ区切りで許可するOriginを指定

## 5. 運用者の閲覧導線
### 5.1 Supabase Dashboard で見る
1. Supabase Dashboard にログイン
2. `Table Editor` を開く
3. `public.form_submissions` を選択
4. `submitted_at` 降順で確認

### 5.2 SQLで見る（推奨クエリ）
Supabase SQL Editor で実行:

```sql
select
  id,
  submitted_at,
  name,
  email,
  message,
  source,
  user_agent
from public.form_submissions
order by submitted_at desc
limit 200;
```

## 6. エラーハンドリングと再送戦略
### 6.1 エラー分類
- 入力エラー（4xx）
  - APIがエラーメッセージを返し、ユーザーに再入力を促す
  - 自動再送しない
- 一時的障害（ネットワーク、429、5xx）
  - 即時リトライ（最大3回、指数バックオフ＋ジッター）
  - 失敗時は `localStorage` に退避して自動再送対象にする
- 恒久的障害（再送不可4xxなど）
  - エラーを表示し、手動修正を促す

### 6.2 再送の実行タイミング
- ページ読み込み時（起動後）
- `online` イベント検知時（ネットワーク復帰）

### 6.3 再送キュー制約
- 最大20件まで保持
- 古いデータから順に破棄（上限超過時）
- 各キューアイテムは最大10回まで再送試行

## 7. 監視のポイント
- APIログに `[api/messages] submit failed` が増加していないか
- `form_submissions` の `submitted_at` が継続して増えているか
- 一時保存メッセージの表示報告が増えていないか

## 8. CLI実施ログ（2026-03-07）
- 実行ログの詳細（project ref / org id / 実行コマンド / デプロイURL）は可変情報のため、チケット `MEZ-140` の `## Codex Workpad` に集約する。
- 本ドキュメントは恒久運用手順（セットアップ、閲覧導線、再送戦略、監視ポイント）のみを保持する。
