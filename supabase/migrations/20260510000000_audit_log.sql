-- ═══════════════════════════════════════════════════════════
-- Audit Log — سجل تدقيق العمليات الحساسة
-- انسخ هذا في Supabase → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════

create table if not exists audit_log (
    id           bigserial primary key,
    actor        text not null default '',           -- اسم المستخدم/الحساب الذي نفّذ العملية
    actor_role   text not null default '',           -- admin / employee / officer / stats
    action       text not null,                      -- approve_leave / reject_leave / approve_permission / reject_permission / save_leave / save_permission / delete / update
    entity_type  text not null,                      -- leave / permission / employee / officer / archive / other_request
    entity_id    bigint,                             -- معرّف السجل
    person_id    bigint,                             -- صاحب الطلب (إن وجد)
    person_type  text,                               -- employee / officer
    details      jsonb default '{}'::jsonb,          -- بيانات إضافية (قبل/بعد، رسالة، ...)
    created_at   timestamptz default now()
);

create index if not exists audit_log_created_at_idx on audit_log (created_at desc);
create index if not exists audit_log_action_idx     on audit_log (action);
create index if not exists audit_log_entity_idx     on audit_log (entity_type, entity_id);

alter table audit_log enable row level security;

drop policy if exists "allow_all_audit_log" on audit_log;
create policy "allow_all_audit_log" on audit_log for all using (true) with check (true);
