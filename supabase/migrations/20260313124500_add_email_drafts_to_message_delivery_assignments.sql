alter table public.message_delivery_assignments
  add column if not exists email_subject text,
  add column if not exists email_html text,
  add column if not exists email_text text,
  add column if not exists draft_created_at timestamptz;

update public.message_delivery_assignments
set status = 'draft'
where status = 'planned';

alter table public.message_delivery_assignments
  drop constraint if exists message_delivery_assignments_status_valid;

alter table public.message_delivery_assignments
  add constraint message_delivery_assignments_status_valid
  check (status in ('planned', 'draft', 'processing', 'sent', 'failed'));

alter table public.message_delivery_assignments
  add constraint message_delivery_assignments_email_subject_not_blank
  check (email_subject is null or char_length(btrim(email_subject)) > 0),
  add constraint message_delivery_assignments_email_html_not_blank
  check (email_html is null or char_length(btrim(email_html)) > 0),
  add constraint message_delivery_assignments_email_text_not_blank
  check (email_text is null or char_length(btrim(email_text)) > 0);
