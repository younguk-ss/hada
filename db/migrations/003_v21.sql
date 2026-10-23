-- (수업)하다 · hada v2.1 — 스냅샷 분리, rev, 필기 키 정리, 정렬 안전, lesson_meta
-- 멱등. 002_v2.sql 이후 실행.

-- 세션 스냅샷 분리 (realtime 미발행 → sessions 이벤트를 작게)
create table if not exists session_snapshots (
  session_id text primary key references sessions(id) on delete cascade,
  slides jsonb not null default '[]'::jsonb
);
alter table session_snapshots enable row level security;
drop policy if exists anon_all_session_snapshots on session_snapshots;
create policy anon_all_session_snapshots on session_snapshots for all using (true) with check (true);

-- 단조 증가 리비전 (늦게 도착한 쓰기·이벤트 무시)
alter table sessions add column if not exists rev bigint not null default 0;

-- 썸네일 URL
alter table slides add column if not exists thumb_url text;

-- slide_records: whole scope_id = session_id (NOT NULL) → 학생 필터 구독 가능
alter table slide_records add column if not exists removed jsonb not null default '[]'::jsonb;
update slide_records set scope_id = session_id where scope = 'whole' and scope_id is null;
delete from slide_records where scope_id is null;
alter table slide_records alter column scope_id set not null;
alter table slide_records drop constraint if exists slide_records_key;
alter table slide_records drop constraint if exists slide_records_session_id_slide_id_scope_scope_id_key;
alter table slide_records add constraint slide_records_key unique (session_id, slide_id, scope, scope_id);
alter table slide_records replica identity default;

-- 슬라이드 순서 교환을 한 번의 upsert로 (트랜잭션 끝에서 검사)
alter table slides drop constraint if exists slides_lesson_id_position_key;
alter table slides add constraint slides_lesson_id_position_key unique (lesson_id, position) deferrable initially deferred;

-- 수업 자료 목록용 메타 뷰 (slides 본문 없이)
create or replace view lesson_meta with (security_invoker = true) as
select l.id, l.teacher_id, l.title, l.created_at, l.updated_at,
  (select count(*) from slides s where s.lesson_id = l.id) as slide_count,
  (select coalesce(s.thumb_url, case when s.bg_url like 'data:%' then null else s.bg_url end)
     from slides s where s.lesson_id = l.id order by s.position limit 1) as cover
from lessons l;

-- realtime: 필요한 테이블만
do $$ begin
  begin execute 'alter publication supabase_realtime add table sessions'; exception when others then null; end;
  begin execute 'alter publication supabase_realtime add table session_participants'; exception when others then null; end;
  begin execute 'alter publication supabase_realtime add table slide_records'; exception when others then null; end;
  begin execute 'alter publication supabase_realtime add table responses'; exception when others then null; end;
  begin execute 'alter publication supabase_realtime drop table slides'; exception when others then null; end;
  begin execute 'alter publication supabase_realtime drop table lessons'; exception when others then null; end;
  begin execute 'alter publication supabase_realtime drop table teachers'; exception when others then null; end;
  begin execute 'alter publication supabase_realtime drop table students'; exception when others then null; end;
end $$;
