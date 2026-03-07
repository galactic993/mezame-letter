create table if not exists public.form_submissions (
  id bigint generated always as identity primary key,
  name text not null,
  email text not null,
  message text not null,
  source text not null default 'mezame-letter',
  user_agent text,
  submitted_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists form_submissions_submitted_at_idx
  on public.form_submissions (submitted_at desc);

alter table public.form_submissions enable row level security;
