-- ═══════════════════════════════════════════════════════════
-- Supabase Schema — Farwaniya HR App
-- انسخ هذا الكود كاملاً والصقه في Supabase → SQL Editor → New Query
-- ═══════════════════════════════════════════════════════════

-- ───── 1. employees ─────
create table if not exists employees (
    id          bigserial primary key,
    name        text not null default '',
    number      text not null default '',
    department  text not null default '',
    shift       text not null default '',
    position    text not null default '',
    hire_date   text not null default '',
    phone       text not null default '',
    status      text not null default 'نشط',
    created_at  timestamptz default now(),
    updated_at  timestamptz
);

-- ───── 2. officers ─────
create table if not exists officers (
    id              bigserial primary key,
    name            text not null default '',
    rank            text not null default '',
    position        text not null default '',
    military_number text not null default '',
    civil_number    text not null default '',
    phone           text not null default '',
    hire_date       text not null default '',
    status          text not null default 'نشط',
    created_at      timestamptz default now(),
    updated_at      timestamptz
);

-- ───── 3. leaves ─────
create table if not exists leaves (
    id           bigserial primary key,
    person_id    bigint not null,
    person_type  text not null default 'employee',
    type         text not null default 'leave',
    person_name  text not null default '',
    leave_type   text not null default '',
    start_date   text not null default '',
    end_date     text not null default '',
    return_date  text not null default '',
    days         integer not null default 0,
    status       text not null default 'pending',
    notes        text not null default '',
    pdf_name     text,
    pdf_data     text,
    created_at   timestamptz default now()
);

-- ───── 4. notes ─────
create table if not exists notes (
    id          bigserial primary key,
    employee_id bigint not null,
    text        text not null default '',
    created_at  timestamptz default now()
);

-- ───── 5. statistics ─────
create table if not exists statistics (
    id                          bigserial primary key,
    date                        text unique not null,
    private_count               integer not null default 0,
    special_transfer_count      integer not null default 0,
    general_transfer_count      integer not null default 0,
    motorcycles_count           integer not null default 0,
    color_change_count          integer not null default 0,
    towing_count                integer not null default 0,
    technical_committees_count  integer not null default 0,
    second_pass_count           integer not null default 0,
    third_pass_count            integer not null default 0,
    created_at                  timestamptz default now(),
    updated_at                  timestamptz
);

-- ───── 6. employee_files ─────
create table if not exists employee_files (
    id          bigserial primary key,
    employee_id bigint not null,
    person_id   bigint,
    date        text not null default '',
    status      text not null default 'pending',
    type        text not null default 'document',
    file_name   text not null default '',
    file_path   text not null default '',
    file_data   text,
    file_size   text not null default '',
    file_type   text not null default '',
    notes       text not null default '',
    created_at  timestamptz default now()
);

-- ───── 7. officer_files ─────
create table if not exists officer_files (
    id          bigserial primary key,
    officer_id  bigint not null,
    type        text not null default 'document',
    file_name   text not null default '',
    file_path   text not null default '',
    file_data   text,
    file_size   text not null default '',
    file_type   text not null default '',
    notes       text not null default '',
    created_at  timestamptz default now()
);

-- ───── 8. leave_permissions ─────
create table if not exists leave_permissions (
    id           bigserial primary key,
    employee_id  bigint not null,
    person_id    bigint,
    request_type text not null default 'permission',
    person_type  text not null default 'employee',
    date         text not null,
    type         text not null,
    status       text not null default 'pending',
    fraction     numeric not null default 1,
    notes        text not null default '',
    created_at   timestamptz default now()
);

-- ───── 9. custom_archive_types ─────
create table if not exists custom_archive_types (
    id    bigserial primary key,
    key   text unique not null,
    name  text not null,
    color text not null default '#6b7280'
);

-- ───── 10. notifications ─────
create table if not exists notifications (
    id        bigserial primary key,
    person_id text not null default 'all',
    title     text not null default '',
    message   text not null default '',
    type      text not null default 'message',
    status    text not null default 'info',
    date      timestamptz default now(),
    read_by   text[] not null default '{}'
);

-- ───── 11. accounts ─────
create table if not exists accounts (
    id         bigserial primary key,
    username   text unique not null,
    password   text not null,
    role       text not null,
    person_id  bigint,
    created_at timestamptz default now()
);

-- ───── 12. other_requests (طلبات أخرى) ─────
create table if not exists other_requests (
    id          bigserial primary key,
    person_id   bigint not null,
    person_name text not null default '',
    person_type text not null default 'employee',
    type        text not null default '',
    description text not null default '',
    status      text not null default 'pending',
    date        timestamptz default now(),
    updated_at  timestamptz
);

-- ───── 13. admin_notifications_store (جرس الأدمن - مخزّن شهرياً) ─────
create table if not exists admin_notifications_store (
    id    bigserial primary key,
    month text unique not null,
    data  jsonb not null default '[]'::jsonb
);

-- ───── 14. app_settings (إعدادات التطبيق - مفتاح/قيمة) ─────
create table if not exists app_settings (
    key   text primary key,
    value jsonb not null default 'null'::jsonb
);

-- ═══════════════════════════════════════════════════════════
-- Row Level Security (RLS) — مهم جداً للأمان
-- ═══════════════════════════════════════════════════════════

-- تفعيل RLS على كل الجداول
alter table employees            enable row level security;
alter table officers             enable row level security;
alter table leaves               enable row level security;
alter table notes                enable row level security;
alter table statistics           enable row level security;
alter table employee_files       enable row level security;
alter table officer_files        enable row level security;
alter table leave_permissions    enable row level security;
alter table custom_archive_types enable row level security;
alter table notifications        enable row level security;
alter table accounts             enable row level security;

-- السماح بالقراءة والكتابة الكاملة عبر anon key (للتطبيق)
-- ملاحظة: في الإنتاج يجب تقييد هذا حسب الدور (role-based)
drop policy if exists "allow_all_employees"            on employees;
drop policy if exists "allow_all_officers"             on officers;
drop policy if exists "allow_all_leaves"               on leaves;
drop policy if exists "allow_all_notes"                on notes;
drop policy if exists "allow_all_statistics"           on statistics;
drop policy if exists "allow_all_employee_files"       on employee_files;
drop policy if exists "allow_all_officer_files"        on officer_files;
drop policy if exists "allow_all_leave_permissions"    on leave_permissions;
drop policy if exists "allow_all_custom_archive_types" on custom_archive_types;
drop policy if exists "allow_all_notifications"        on notifications;
drop policy if exists "allow_all_accounts"             on accounts;

create policy "allow_all_employees"            on employees            for all using (true) with check (true);
create policy "allow_all_officers"             on officers             for all using (true) with check (true);
create policy "allow_all_leaves"               on leaves               for all using (true) with check (true);
create policy "allow_all_notes"                on notes                for all using (true) with check (true);
create policy "allow_all_statistics"           on statistics           for all using (true) with check (true);
create policy "allow_all_employee_files"       on employee_files       for all using (true) with check (true);
create policy "allow_all_officer_files"        on officer_files        for all using (true) with check (true);
create policy "allow_all_leave_permissions"    on leave_permissions    for all using (true) with check (true);
create policy "allow_all_custom_archive_types" on custom_archive_types for all using (true) with check (true);
create policy "allow_all_notifications"        on notifications        for all using (true) with check (true);
create policy "allow_all_accounts"             on accounts             for all using (true) with check (true);
alter table other_requests              enable row level security;
alter table admin_notifications_store   enable row level security;
alter table app_settings                enable row level security;

drop policy if exists "allow_all_other_requests"            on other_requests;
drop policy if exists "allow_all_admin_notifications_store" on admin_notifications_store;
drop policy if exists "allow_all_app_settings"              on app_settings;

create policy "allow_all_other_requests"            on other_requests            for all using (true) with check (true);
create policy "allow_all_admin_notifications_store" on admin_notifications_store for all using (true) with check (true);
create policy "allow_all_app_settings"              on app_settings              for all using (true) with check (true);
