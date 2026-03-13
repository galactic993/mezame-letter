# ランダムメッセージ送信運用ガイド

## 1. 目的
`public.form_submissions` に保存された投稿を対象に、締切後に 1 回だけランダム割り当てし、メッセージ本文を直接含む匿名メール下書きを DB に保存する。実際の Resend 送信は別 API で実行する。

## 2. 実装構成
- API: `api/send-random-messages.js`
  - `GET /api/send-random-messages` または `POST /api/send-random-messages`
  - `CRON_SECRET` による Bearer 認証
  - 締切日時以前の投稿だけを取得し、締切前は下書きを作らない
  - 同一メールアドレスの投稿を 1 送信者グループに束ねる
  - 元データから独立に 1568 回 Sattolo shuffle を実行し、自己配送なしの組み合わせを作る
  - 配信割り当て、受信者専用 `access_token`、メール件名・本文の下書きを `public.message_delivery_assignments` に永続化
  - 下書き本文には送信者名を含めず、代表メッセージ 1 件だけを直接掲載する
- API: `api/send-random-message-drafts.js`
  - `GET /api/send-random-message-drafts` または `POST /api/send-random-message-drafts`
  - `draft` / `planned` / `failed` のレコードだけを `processing` に claim して Resend 送信する
- API: `api/message-view.js`
  - `GET /api/message-view?token=...` で専用URLの内容を返す
  - 開封時に `opened_at` / `view_count` を更新する
- フロントエンド: `message.html`
  - メールから遷移した専用ページ
  - アニメーション演出のあとにメッセージ本文を表示する
- DB: `supabase/migrations/20260308113000_create_message_delivery_assignments_table.sql`
  - 送信者と受信者の対応表
  - `campaign_key + sender_email` / `campaign_key + recipient_email` を一意制約で保護
  - `draft / processing / sent / failed` を中心に状態を保持する
  - `email_subject` / `email_html` / `email_text` / `draft_created_at` に下書き本文を保存する

## 3. 必要な環境変数
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_MESSAGES_TABLE`
  - 任意。既定値は `form_submissions`
- `SUPABASE_DELIVERY_ASSIGNMENTS_TABLE`
  - 任意。既定値は `message_delivery_assignments`
- `SUPABASE_SCHEMA`
  - 任意。既定値は `public`
- `CRON_SECRET`
  - Vercel Cron が付与する `Authorization: Bearer <secret>` と一致させる
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
  - Resend で検証済みドメインの送信元を設定する
  - 例: `目醒めレター <mezame-letter@christmas-planet.co.jp>`
- `RESEND_REPLY_TO_EMAIL`
  - 任意
- `PUBLIC_SITE_URL`
  - 受信者向けURLを組み立てるための公開ベースURL
  - 例: `https://christmas-planet.co.jp`
- `RANDOM_MESSAGE_CAMPAIGN_KEY`
  - 任意。既定値は `2026-03-13`
- `RANDOM_MESSAGE_ACCEPTANCE_DEADLINE_JST`
  - 締切日時。ここまでは投稿を受け付ける
  - 例: `2026-03-13T17:30:00+09:00`
- `RANDOM_MESSAGE_SEND_DATE_JST`
  - 任意。明示指定するとこの日時以降に送信する
- `RANDOM_MESSAGE_SEND_DELAY_MINUTES`
  - 任意。`RANDOM_MESSAGE_SEND_DATE_JST` 未指定時だけ使用
  - 既定値は `90`
  - `RANDOM_MESSAGE_ACCEPTANCE_DEADLINE_JST + 90分` を送信開始日時として扱う
- `RANDOM_MESSAGE_SHUFFLE_COUNT`
  - 任意。既定値は `1568`

## 4. 初回セットアップ
1. Supabase migration を適用する

```bash
supabase db push
```

2. Vercel に上記環境変数を登録する
3. Resend 側で `RESEND_FROM_EMAIL` のドメインを verify する
4. Vercel の Cron で `Authorization` ヘッダーが `Bearer <CRON_SECRET>` になるよう設定する
5. Xserver の DNS に Resend 指定のレコードを追加して `christmas-planet.co.jp` を検証する
6. 送信元メールアドレス `mezame-letter@christmas-planet.co.jp` を Xserver 側で作成する

## 5. 配信ロジック
1. `form_submissions` から締切以前の投稿を取得する
2. メールアドレス単位で投稿を束ねる
3. 参加者一覧を元に、1568 回独立に shuffle した最後の結果を採用する
4. 作成した割り当てを `message_delivery_assignments` に保存し、件名・HTML・テキスト本文も下書きとして保存する
5. 同一メールアドレスに複数投稿がある場合でも、受信メールに掲載する本文は代表 1 件だけに絞る
6. 送信タイミングで `api/send-random-message-drafts` を呼び、`draft` / `failed` のレコードを `processing` に claim してから Resend 送信する
7. 受信者が専用URLを開くと `message.html` が `api/message-view` から本文を取得して表示する
8. 成功時は `sent`、失敗時は `failed` に更新する

## 6. 今回の設定例
1. Xserver で `mezame-letter@christmas-planet.co.jp` を作成する
2. Resend で `christmas-planet.co.jp` を検証し、`RESEND_FROM_EMAIL` を `目醒めレター <mezame-letter@christmas-planet.co.jp>` にする
3. 投稿締切を 2026-03-13 17:30 JST にしたい場合は `RANDOM_MESSAGE_ACCEPTANCE_DEADLINE_JST=2026-03-13T17:30:00+09:00` を設定する
4. `PUBLIC_SITE_URL=https://christmas-planet.co.jp` を設定する
5. 締切後に `POST /api/send-random-messages` を実行して下書きを保存する
6. 内容確認後、90 分後の 2026-03-13 19:00 JST 以降に `POST /api/send-random-message-drafts` を実行して一括送信する
## 7. 運用確認クエリ
```sql
select
  campaign_key,
  sender_email,
  recipient_email,
  status,
  email_subject,
  draft_created_at,
  sent_at,
  last_error
from public.message_delivery_assignments
order by id asc;
```

## 8. 注意点
- 一意なメールアドレスが 2 件未満の場合は配信しない
- 同一メールアドレスの複数投稿は 1 人分として扱い、受信メールには代表 1 件のみ掲載する
- 受信者向けのメール本文・専用ページには送信者名を表示しない
- `message_delivery_assignments` を作成した後は、そのスナップショットを基準にするため、締切後の新規投稿は配信対象に入らない
- `api/send-random-messages` は既存の `planned` レコードを検出すると `draft` へ補完し、下書き本文をバックフィルする
