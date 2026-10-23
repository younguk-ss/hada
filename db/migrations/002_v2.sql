-- (수업)하다 · hada v2 — 슬라이드 타입 / 응답 / 활동 상태 / Storage
-- 기존 데이터 보존 (DROP TABLE 없음). 여러 번 실행해도 안전(idempotent).

-- ── 슬라이드 타입 ────────────────────────────────────────────
alter table slides add column if not exists type text not null default 'ink';
alter table slides add column if not exists title text;
alter table slides add column if not exists config jsonb not null default '{}'::jsonb;

alter table lessons add column if not exists updated_at timestamptz not null default now();
alter table sessions add column if not exists activity jsonb not null default '{}'::jsonb;
alter table sessions add column if not exists last_writer text;
alter table slide_records add column if not exists last_writer text;

-- ── slide_records: whole scope(scope_id NULL) 중복 방지 ────────
-- 기존 unique 는 NULL 끼리 서로 다르게 취급 → upsert 가 매번 새 행을 만듦. NULLS NOT DISTINCT 로 교체.
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.slide_records'::regclass and contype = 'u' limit 1;
  if c is not null then execute format('alter table slide_records drop constraint %I', c); end if;
  -- 중복 정리: 같은 키의 최신 행만 남김
  delete from slide_records a using slide_records b
   where a.session_id = b.session_id and a.slide_id = b.slide_id and a.scope = b.scope
     and a.scope_id is not distinct from b.scope_id and a.id < b.id;
  alter table slide_records add constraint slide_records_key unique nulls not distinct (session_id, slide_id, scope, scope_id);
end$$;

-- ── 응답 (퀴즈·서술형·워드클라우드·담벼락·게임 결과) ──────────
create table if not exists responses (
  id bigserial primary key,
  session_id text not null references sessions(id) on delete cascade,
  slide_id text not null,
  student_id text not null,
  item_key text not null default '',
  payload jsonb not null default '{}'::jsonb,
  score numeric,
  correct boolean,
  time_ms int,
  last_writer text,
  updated_at timestamptz not null default now(),
  unique (session_id, slide_id, student_id, item_key)
);
create index if not exists idx_responses_session on responses(session_id, slide_id);
alter table responses enable row level security;
do $$ begin
  create policy anon_all_responses on responses for all using (true) with check (true);
exception when duplicate_object then null; end $$;

-- DELETE 이벤트에도 전체 행이 오도록 (담벼락 삭제 등 증분 반영)
alter table responses replica identity full;
alter table slide_records replica identity full;
alter table session_participants replica identity full;

do $$
begin
  perform 1 from pg_publication where pubname = 'supabase_realtime';
  if found then
    begin execute 'alter publication supabase_realtime add table responses'; exception when others then null; end;
  end if;
end$$;

-- ── Storage: 슬라이드 이미지 public 버킷 ───────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('slides', 'slides', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists anon_read_slides on storage.objects;
drop policy if exists anon_insert_slides on storage.objects;
drop policy if exists anon_update_slides on storage.objects;
drop policy if exists anon_delete_slides on storage.objects;
create policy anon_read_slides on storage.objects for select using (bucket_id = 'slides');
create policy anon_insert_slides on storage.objects for insert with check (bucket_id = 'slides');
create policy anon_update_slides on storage.objects for update using (bucket_id = 'slides') with check (bucket_id = 'slides');
create policy anon_delete_slides on storage.objects for delete using (bucket_id = 'slides');
