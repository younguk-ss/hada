# (수업)하다 · hada v2

학생과 필기를 공유하고 소통하며 함께 수업하는 실시간 인터랙티브 수업 웹앱 (Lumio·Nearpod 방식).

- 교사마다 **고정 6자리 코드** — 학생은 코드만 입력하면 진행 중인 수업으로 바로 들어가고, 수업 전이면 기다렸다가 자동 입장
- 교사는 수업 자료에서 **시작**만 누르면 됨
- 필기 슬라이드: 발표 · 전체 · 개별 · 모둠 모드를 수업 중 1탭 전환, 개별/모둠 실시간 갤러리
- 상호작용: 객관식, 설문(정답 없는 의견 고르기), 주관식·서술형, 빈칸 채우기, 워드클라우드, 분류하기(드래그앤드롭), 담벼락
- 수업 중 상호작용 추가: 패널에서 빈 슬라이드·담벼락·주관식·워드클라우드·설문·웹 링크·임베드·동영상을 골라 바로 다음 슬라이드로 끼워 넣고 이동
- 미디어: 웹 링크, 임베드, 동영상(YouTube·mp4), 동영상 퀴즈(시점별 문제)
- 게임: 공룡 점프(정확도+시간 순위), 레이싱 퀴즈(최대 4명 랜덤 조, 정답 부스터·오답 미끄러짐, 2바퀴, 조별 랩타임)
- 수업 기록: 슬라이드별/학생별, 인쇄
- 복습 QR·링크: 수업마다 새 복습 코드 — 학습지(학생 결과·빈 학습지) 장마다 QR·코드가 인쇄되고, 수업 기록 목록·상세에서 `[복습 링크]`를 누르면 주소가 바로 복사됨(결석생·다시 공부할 학생에게 전달). 학생은 그 수업을 자기 페이스로 첫 슬라이드부터 복습(선생님·친구들 기록은 그대로, 문제는 다시 풀기)
- 텍스트 상자: 텍스트 도구로 쓴 글자 칸을 끌어 옮기고(✥), 칸 크기를 바꾸고(↘), 글자 크기를 키우고 줄임(가− 가+) — 학생·교사 공통
- 팝업 상호작용: 편집기에서 필기 슬라이드 위에 핀(객관식·주관식·설문 등)을 넣어 두면, 수업 중 핀을 누를 때 교사·학생 화면에 함께 팝업으로 떠서 진행
- 결과 가리기: 정답이 있는 활동은 학생이 답하는 동안 교사 화면에 응답 수만 보이고, [마감]·[정답 공개]를 눌러야 결과가 보임(칠판 미리 보기 방지)
- 문제 그림: 모든 상호작용·게임의 문제에 그림을 넣을 수 있음(누르면 크게)
- 학습지: 편집기 `[📝 학습지]`에 PDF·이미지를 미리 올려 두면 수업 중 학생이 화면 오른쪽 📝 탭으로 열어 각자 필기. 교사는 같은 탭으로 학생들의 필기를 실시간 갤러리로 보고(확대·첨삭), `[학생 화면에 띄우기]`로 모든 학생 화면을 학습지로 바꿀 수 있음(쪽 이동은 자유). 기록·복습·인쇄에도 포함

설계 문서: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## 로컬 실행

```bash
python3 tools/devserver.py 5173
```

http://localhost:5173 — 캐시를 끈 정적 서버입니다(ES 모듈이 옛 버전으로 남지 않게). `env.js`에 Supabase 키가 없으면 단일 브라우저 데모 모드로 동작합니다.

## Supabase 셋업 (새 프로젝트)

1. https://supabase.com → New project
2. SQL Editor에서 순서대로 실행: `db/migrations/001_v1.sql` → `002_v2.sql` → `003_v21.sql` → `004_review_code.sql` → `005_worksheet.sql`
   - ⚠️ `001_v1.sql`은 `drop table`을 포함하므로 **새 프로젝트에서만** 실행하세요. 기존 프로젝트는 002부터.
   - 002가 Storage 버킷 `slides`(public)와 정책까지 만듭니다.
3. Project Settings → API → Project URL, publishable key를 `env.js`에 넣기:

```js
window.HADA_SUPABASE_URL = "https://xxx.supabase.co";
window.HADA_SUPABASE_ANON = "sb_publishable_...";
```

예전(v1) 방식으로 저장된 슬라이드 이미지(base64)는 교사가 그 수업 자료를 처음 열 때 자동으로 Storage로 옮겨집니다.

## 배포

`main`에 push하면 Vercel이 자동 배포합니다(Vercel ↔ GitHub 연결). 수동 배포:

```bash
npx vercel deploy --prod --yes
```

## 디렉터리

```
index.html, styles.css, env.js
js/
  app.js            라우트·부트·로그인
  router.js, ui.js  라우터, UI 헬퍼(toast·dialog·sheet·icon)
  store.js, sync.js 상태(슬림 영속), 로컬 모드 탭 동기화
  cloud.js          Supabase 어댑터(증분 구독, rev, 병합)
  storage.js        슬라이드 이미지 업로드·썸네일·PDF 변환
  realtime.js       세션 채널(broadcast·presence)
  canvas.js, lesson-view.js   필기 캔버스·슬라이드 프레임
  worksheet.js      학습지 공용(📝 탭·작성 상태·개별 모드 세션 보기)
  teacher.js, student.js      교사·학생 화면
  slides/           슬라이드 타입 플러그인(registry·host·common + 14개 타입)
db/migrations/      SQL 마이그레이션
tools/devserver.py  로컬 개발 서버
```
