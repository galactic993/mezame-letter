# ランダムメッセージ送信運用ガイド

## 1. 目的
2026-03-11 23:59:59 JST までに `public.form_submissions` に保存された投稿を対象に、2026-03-13 以降に 1 回だけランダム割り当てして Resend で配信する。

## 2. 実装構成
- API: `api/send-random-messages.js`
  - Vercel Cron から `GET /api/send-random-messages` を実行
  - `CRON_SECRET` による Bearer 認証
  - 締切日時以前の投稿だけを取得
  - 同一メールアドレスの投稿を 1 送信者グループに束ねる
  - 元データから独立に 1568 回 Sattolo shuffle を実行し、自己配送なしの組み合わせを作る
  - 配信割り当てを `public.message_delivery_assignments` に永続化
  - 未送信または失敗分だけ Resend で再送
- DB: `supabase/migrations/20260308113000_create_message_delivery_assignments_table.sql`
  - 送信者と受信者の対応表
  - `campaign_key + sender_email` / `campaign_key + recipient_email` を一意制約で保護
  - `planned / processing / sent / failed` の状態を保持
- Cron: `vercel.json`
  - `0 1 * * *` で毎日 10:00 JST 相当を起点に実行
  - コード側で `RANDOM_MESSAGE_SEND_DATE_JST` 未満は拒否するため、実際の配信は 2026-03-13 以降のみ

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
- `RESEND_REPLY_TO_EMAIL`
  - 任意
- `RANDOM_MESSAGE_CAMPAIGN_KEY`
  - 任意。既定値は `2026-03-13`
- `RANDOM_MESSAGE_ACCEPTANCE_DEADLINE_JST`
  - 任意。既定値は `2026-03-11T23:59:59.999+09:00`
- `RANDOM_MESSAGE_SEND_DATE_JST`
  - 任意。既定値は `2026-03-13T00:00:00+09:00`
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

## 5. 配信ロジック
1. `form_submissions` から締切以前の投稿を取得
2. メールアドレス単位で投稿を束ねる
3. 参加者一覧を元に、1568 回独立に shuffle した最後の結果を採用する
4. 作成した割り当てを `message_delivery_assignments` に保存する
5. `planned` / `failed` のレコードを `processing` に claim してから Resend 送信する
6. 成功時は `sent`、失敗時は `failed` に更新する

## 6. 運用確認クエリ
```sql
select
  campaign_key,
  sender_email,
  recipient_email,
  status,
  sent_at,
  last_error
from public.message_delivery_assignments
order by id asc;
```

## 7. 注意点
- 一意なメールアドレスが 2 件未満の場合は配信しない
- 同一メールアドレスの複数投稿は 1 人分として同じ受信者にまとめて送る
- `message_delivery_assignments` を作成した後は、そのスナップショットを基準に再送するため、締切後の新規投稿は配信対象に入らない
