-- (수업)하다 · hada v2.15 — 교과(subjects): 수업 자료를 교과별로 나눠 보기
-- 멱등. 005_worksheet.sql 이후 실행. 기존 데이터 보존(테이블·열 추가만).
--
-- 교과 = 교사마다 만드는 분류(국어·수학 …). 수업 자료(lessons)는 교과 하나에 들어가거나(subject_id) 미분류(null).
-- 기존 자료는 모두 subject_id = null → 앱에서 '미분류'로 보인다. 교과를 지우면 그 자료는 다시 미분류(on delete set null).
-- 수업 기록(sessions)은 자기 수업 자료의 교과를 따른다(열 추가 없음).

-- ── 교과 ─────────────────────────────────────────────────────
create table if not exists subjects (
  id text primary key,
  teacher_id text not null references teachers(id) on delete cascade,
  name text not null,
  position int not null default 0,
  color text,
  created_at timestamptz not null default now()
);
create index if not exists idx_subjects_teacher on subjects(teacher_id);
alter table subjects enable row level security;
drop policy if exists anon_all_subjects on subjects;
create policy anon_all_subjects on subjects for all using (true) with check (true);

-- ── 수업 자료의 교과 ──────────────────────────────────────────
alter table lessons add column if not exists subject_id text references subjects(id) on delete set null;
create index if not exists idx_lessons_subject on lessons(subject_id);
