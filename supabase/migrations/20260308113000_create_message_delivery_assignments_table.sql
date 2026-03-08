create table if not exists public.message_delivery_assignments (
  id bigint generated always as identity primary key,
  campaign_key text not null,
  sender_email text not null,
  sender_name text not null,
  sender_messages jsonb not null,
  sender_message_count integer not null,
  recipient_email text not null,
  recipient_name text not null,
  shuffle_count integer not null,
  status text not null default 'planned',
  resend_email_id text,
  delivery_started_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint message_delivery_assignments_campaign_sender_unique unique (campaign_key, sender_email),
  constraint message_delivery_assignments_campaign_recipient_unique unique (campaign_key, recipient_email),
  constraint message_delivery_assignments_sender_email_not_blank check (char_length(btrim(sender_email)) > 0),
  constraint message_delivery_assignments_recipient_email_not_blank check (char_length(btrim(recipient_email)) > 0),
  constraint message_delivery_assignments_sender_name_not_blank check (char_length(btrim(sender_name)) > 0),
  constraint message_delivery_assignments_recipient_name_not_blank check (char_length(btrim(recipient_name)) > 0),
  constraint message_delivery_assignments_sender_message_count_positive check (sender_message_count > 0),
  constraint message_delivery_assignments_shuffle_count_positive check (shuffle_count > 0),
  constraint message_delivery_assignments_status_valid check (
    status in ('planned', 'processing', 'sent', 'failed')
  )
);

create index if not exists message_delivery_assignments_campaign_status_idx
  on public.message_delivery_assignments (campaign_key, status);

alter table public.message_delivery_assignments enable row level security;
