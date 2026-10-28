-- (수업)하다 · hada v2.6 — 학습지(worksheet)
-- 멱등. 004_review_code.sql 이후 실행. 기존 데이터 보존(테이블·열 추가만).
--
-- 학습지 = 수업 자료(lesson)에 미리 올려 둔 PDF·이미지 페이지. 학생은 수업 중 오른쪽 📝 탭으로 열어 각자(individual) 필기하고,
-- 교사는 갤러리로 실시간 확인·[학생 화면에 띄우기](sessions.activity.__ws.force)를 한다.
-- 학생 필기는 기존 slide_records(slide_id = 학습지 페이지 id, scope 'individual')에 그대로 저장된다.

-- ── 수업 자료별 학습지 페이지 ────────────────────────────────
create table if not exists worksheet_pages (
  id text primary key,
  lesson_id text not null references lessons(id) on delete cascade,
  position int not null,
  title text,
  bg_url text,
  bg_path text,
  thumb_url text,
  base_strokes jsonb not null default '[]'::jsonb,
  base_texts jsonb not null default '[]'::jsonb,
  unique (lesson_id, position) deferrable initially deferred
);
create index if not exists idx_worksheet_pages_lesson on worksheet_pages(lesson_id);
alter table worksheet_pages enable row level security;
drop policy if exists anon_all_worksheet_pages on worksheet_pages;
create policy anon_all_worksheet_pages on worksheet_pages for all using (true) with check (true);

-- ── 세션 스냅샷에 학습지 페이지(시작 후 불변) ──────────────────
alter table session_snapshots add column if not exists worksheet jsonb not null default '[]'::jsonb;
