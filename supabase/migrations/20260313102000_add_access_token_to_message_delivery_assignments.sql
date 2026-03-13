alter table public.message_delivery_assignments
  add column if not exists access_token text,
  add column if not exists opened_at timestamptz,
  add column if not exists view_count integer not null default 0;

alter table public.message_delivery_assignments
  add constraint message_delivery_assignments_access_token_not_blank
  check (access_token is null or char_length(btrim(access_token)) > 0);

create unique index if not exists message_delivery_assignments_access_token_key
  on public.message_delivery_assignments (access_token)
  where access_token is not null;
