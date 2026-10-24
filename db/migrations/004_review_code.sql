-- (수업)하다 · hada v2.5 — 세션별 복습 코드 (학습지 QR)
-- 멱등. 003_v21.sql 이후 실행. 기존 데이터 보존(열 추가만).

-- 수업(세션)마다 6자리 복습 코드. 교사 참여 코드와 같은 문자(0/O/1/I 제외).
-- 앱이 처음 필요할 때(수업 시작 직후·기록·인쇄) 채운다 → 기존 세션은 NULL로 두어도 된다.
alter table sessions add column if not exists review_code text;
create unique index if not exists sessions_review_code_key on sessions(review_code);
