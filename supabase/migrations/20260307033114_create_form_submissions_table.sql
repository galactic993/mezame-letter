create table if not exists public.form_submissions (
  id bigint generated always as identity primary key,
  name text not null,
  email text not null,
  message text not null,
  source text not null default 'mezame-letter',
  user_agent text,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
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
