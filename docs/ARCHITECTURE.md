# (수업)하다 · hada — v2 아키텍처 명세 (확정본 v2.1)

이 문서는 v2 재구성의 **단일 기준**이다. 여러 에이전트가 서로 다른 파일을 동시에 구현하므로, 여기 적힌 **이름·시그니처·데이터 형태·CSS 클래스**를 그대로 따른다. 모호하면 이 문서의 문장을 우선하고, 문서에 없는 것은 "가장 단순한 것"을 택한 뒤 파일 상단 주석에 `// 가정:`으로 남긴다.

- 빌드 도구 없음. 순수 ES 모듈(`<script type="module">`), CDN만. Node/npm 의존성 추가 금지.
- UI 문구는 한국어, 코드 주석은 한국어(짧게), 식별자는 영어. 기존 코드의 들여쓰기(2칸)·`el()` 헬퍼 스타일을 따른다.
- native `alert/confirm/prompt` **금지** → `ui.js`의 `toast / confirmDialog / promptDialog`.
- `Date.now()`는 자유롭게 사용 가능(브라우저 코드).

---

## 0. 제품 모델 (Lumio 식)

- 교사는 **고정 6자리 코드**(`teachers.join_code`, 대문자·숫자, 0/O/1/I 제외)를 가진다.
- 학생은 코드 + 학년/반/번호/이름으로 입장 → 그 교사의 **현재 LIVE 세션**으로 바로 들어간다. LIVE가 없으면 대기 화면에서 기다리다 교사가 시작하면 **자동 입장**.
- 교사는 수업 자료 카드의 `시작`만 누르면 된다(모달 없음).
- 세션 = 수업 1회. 수업 자료(lesson)의 슬라이드 **스냅샷(시작 후 불변 — 단, 수업 중 [상호작용 추가]로 끼워 넣기만 예외, §9.1)** 을 가진다. 슬라이드는 여러 **타입**(필기·퀴즈·미디어·게임).
- 필기(ink) 슬라이드는 모드 `none(발표)`/`whole(전체)`/`individual(개별)`/`group(모둠)`를 가지며 교사가 수업 중 1탭으로 전환한다. 새로 만드는 필기 슬라이드(빈 슬라이드·PDF·이미지 가져오기)의 기본 모드는 **발표**(v2.8). 수업 중 [추가 → 빈 슬라이드]만 바로 함께 쓰도록 전체.
- 실시간: 교사→학생(슬라이드 이동·모드·활동 상태), 학생→교사(필기·응답·게임 결과). **지연·깜빡임 없어야 한다.**

## 1. v1의 결함 (실측 근거) — 다시 만들지 말 것

1. `slides.bg_url`에 base64 JPEG(234장 = 38 MB). `pullSnapshot()`이 부팅·모든 realtime 이벤트마다 7개 테이블 전체 조회 → anon `statement_timeout 3s` 초과로 **HTTP 500** → 모든 lesson의 slides가 `[]`로 덮임 → 편집기 빈 화면, 세션 스냅샷 `[]` → `slide.mode` TypeError → "수업 시작 안 됨", "학생 백지".
2. `deleteLesson`/`deleteSession`/편집이 로컬만 수정 → 다음 pull이 되돌림.
3. 학생 입장이 **로컬 store**에서 코드·세션을 찾음(부팅 pull 전엔 없음). 학생 id를 로컬에서 생성 → 다른 기기에서 `unique(grade,class_num,num,name)` 위반 → participants FK 실패.
4. `go(path)`가 현재 해시와 같으면 아무 일도 안 함 → 두 번째 `수업 시작` 무반응.
5. 뷰들이 `session`/`lesson` 객체를 클로저에 붙잡음 → pull 후 분리된 객체를 수정.
6. 교사 대시보드가 store 변경마다 탭 전체 재렌더 → 라이브 캔버스 계속 파괴, 1.5초 interval 누적.
7. `.auth-card .row { grid-template-columns: 1fr 1fr 1fr }` + number input 고유 폭 → 카드 밖으로 넘침.
8. 매 store.set마다 전체 상태 JSON을 localStorage에 동기 저장(렉의 원인), 한도 초과 시 bg 삭제 → 백지.
9. sessions 행 하나에 스냅샷 전체를 매 클릭 upsert → 이벤트 1MB 한도 초과 시 드롭.
10. whole/group 필기를 배열 통째로 덮어쓰기(last-writer-wins) → 동시 필기 시 남의 획 소실.

## 2. v2 원칙

1. **이미지는 Supabase Storage**(public 버킷 `slides`). DB·localStorage에는 URL만.
2. **전체 pull 금지.** 부팅 시 필요한 작은 행만. lesson의 slides는 **열 때만**, 세션 데이터는 **그 세션만**. 이후 realtime 증분.
3. **세션 스냅샷은 별도 테이블**(`session_snapshots`, realtime 미발행). `sessions` 행은 작게(< 50 KB) 유지.
4. **교사만 sessions 행을 쓴다.** 학생은 `slide_records`/`responses`/`session_participants`/broadcast만 쓴다.
5. 순간 데이터(게임 진행, 세션 패치 선반영)는 **Broadcast**, 영속 데이터는 테이블 + postgres_changes(필터 사용).
6. 슬라이드 타입은 **플러그인**(`js/slides/<type>.js`). 코어(teacher.js/student.js/host.js)는 타입별 분기를 하지 않는다(ink의 "모드 seg"만 예외: `effectiveMode` 사용).
7. 뷰는 store를 구독하되, **키가 같으면 DOM 보존**(캔버스/플레이어/게임 깜빡임 금지). 모든 라우트 핸들러는 **cleanup 함수를 반환**(구독·타이머·채널 해제).
8. 로컬 모드(Supabase 미설정)는 단일 브라우저 데모로 **죽지 않고** 동작(BroadcastChannel). 품질 목표는 클라우드 모드.

---

## 3. 데이터 모델

### 3.1 클라이언트 객체 (camelCase)

```js
teacher  = { id, name, passwordHash, joinCode }
student  = { id, grade, classNum, num, name }
subject  = { id, teacherId, name, position, color }   /* v2.15 교과. 교사마다, position 순서로 보임 */
lesson   = { id, teacherId, title, createdAt, updatedAt, slideCount, cover /*첫 슬라이드 썸네일 URL|null*/, subjectId /*교과 id|null = 미분류(v2.15)*/,
             slides: Slide[] | null /* null = 아직 안 불러옴 */,
             worksheet: Slide[] | null /* 학습지 쪽(ink 모양, mode 'individual', §9.5). null = 아직 안 불러옴 → 저장 때 건드리지 않음 */ }
Slide    = { id, type /*'ink'|'mcq'|…*/, title /*string|null*/, config /*object, 타입별*/,
             // ink 전용(다른 타입은 생략 가능):
             bg /*URL|null*/, bgPath /*storage path|null*/, thumb /*URL|null*/, mode /*'none'|'whole'|'individual'|'group'*/,
             strokes /*Stroke[] 편집기 기본 필기*/, texts /*Text[]*/ }
             // ink config.images(v2.10): 슬라이드 위에 놓인 이미지(배경 위·필기 아래). slides.config(jsonb)에 들어가므로 DB 변경 없음
             //   Img = { id, url, path /*storage path|null(로컬)*/, x, y /*왼쪽 위, 프레임 정규화*/, w /*프레임 폭 비율*/, ar /*가로/세로*/ }  높이 = w × 1.6 / ar
session  = { id, lessonId, teacherId, title, status /*'live'|'stopped'|'completed'*/, flow /*'teacher'|'student'*/,
             currentSlide /*int*/, rev /*number, 단조 증가*/, groups: [{ id, name, memberIds: [] }],
             reviewCode /*6자리 복습 코드|undefined — 학습지 QR, §9.4*/,
             activity: { [slideId]: ActivityState }, startedAt, endedAt,
             participants: studentId[], slidesSnapshot: Slide[],
             worksheet: Slide[] /* 학습지 스냅샷(시작 때 lesson.worksheet 복사, 불변). 학생 필기는 records[studentId][pageId] */,
             records: { __whole: { [slideId]: Rec }, __groups: { [groupId]: { [slideId]: Rec } }, [studentId]: { [slideId]: Rec } },
             responses: { [slideId]: Response[] } }
Rec      = { strokes: Stroke[], texts: Text[], removed: string[] /* 지운 stroke·text id (병합용 tombstone, 모든 scope) */ }
             // DB·실시간에서는 획을 압축하고(js/ink-codec.js) 한 쪽이 여러 행으로 나뉜다(v2.18.2, §5.1 cloudWriteRecord). 메모리 Rec 모양은 그대로
Stroke   = { id /*'st_…'*/, by /*작성자 id*/, tool /*'pen'|'highlight'|'eraser'*/, color, size, ts, points: [{x,y,p}] /* 0..1, 소수 4자리로 반올림 */,
             shape? /*'line'|'arrow'|'rect'|'ellipse'|'tri' (v2.10 도형)*/, box? /*[시작x, 시작y, 끝x, 끝y] 정규화*/ }
             // 도형: 그리기는 box로 정확하게, points는 윤곽을 기준 화면 8px 간격으로 채운 점(지우개·필기 범위·이전 버전 화면용)
Text     = { id /*'tx_…'*/, by, x, y, value, size, color, ts,
             runs? /*[{ t, c }] 부분 색(v2.10) — t를 이으면 value, c=null이면 color. 맞지 않으면 무시하고 한 색*/ }
Response = { id /*DB bigserial number; 로컬 임시는 음수*/, sessionId, slideId, studentId, itemKey /*'' 기본*/,
             payload /*object*/, score /*number|null*/, correct /*boolean|null*/, timeMs /*int|null*/, updatedAt /*ms*/ }
ActivityState = { phase: 'idle'|'running'|'ended', startedAt?, endsAt?, reveal?: boolean, mode?: InkMode, ...타입별 필드 }
```

- **모드 읽기는 반드시** `effectiveMode(slide, session)` = `session?.activity?.[slide.id]?.mode ?? slide.mode ?? 'none'` (registry.js export). 수업 중 모드 전환은 `activity[slideId].mode`에 기록(스냅샷은 불변).
- `activity[slideId]`가 없으면 `{ phase: 'idle' }`로 간주.

### 3.2 DB (Supabase) — 마이그레이션 파일

- `db/migrations/001_v1.sql` = 기존 `db/schema.sql` 이동본(맨 위에 `-- ⚠️ 새 프로젝트 전용. 기존 DB에 실행 금지(drop table 포함)` 주석). `db/schema.sql`은 삭제.
- `db/migrations/002_v2.sql`, `003_v21.sql` = **이미 실 DB에 적용됨**(리드가 관리). 에이전트는 DB를 직접 바꾸지 않는다. `db/schema.sql`은 001로 이동 완료.

최종 스키마(적용 완료 기준):
```
teachers(id text pk, name unique, password_hash, join_code unique, created_at)
students(id text pk, grade, class_num, num, name, created_at, unique(grade,class_num,num,name))
lessons(id pk, teacher_id fk, title, created_at, updated_at, subject_id fk → subjects on delete set null /*006*/)
subjects(id text pk, teacher_id fk cascade, name, position int, color, created_at)   -- 006: 교과. 없는 DB면 앱이 교과 기능만 끔(cloud.js subjState)
slides(id pk, lesson_id fk cascade, position, type default 'ink', title, config jsonb, bg_url, bg_path, thumb_url, gs_embed, mode, base_strokes jsonb, base_texts jsonb,
       unique(lesson_id, position) DEFERRABLE INITIALLY DEFERRED)
sessions(id pk, lesson_id fk, teacher_id fk, title, status, flow, current_slide, groups jsonb, activity jsonb, rev bigint default 0,
         slides_snapshot jsonb /*레거시: v2는 '[]'*/, started_at, ended_at, last_writer,
         review_code text unique /*004: 수업별 복습 코드, NULL 허용 — SESSION_COLS에 넣지 않고 따로 읽고 씀*/)
session_snapshots(session_id pk fk cascade, slides jsonb, worksheet jsonb default '[]' /*005: 학습지 스냅샷*/)   -- realtime 미발행
worksheet_pages(id pk, lesson_id fk cascade, position, title, bg_url, bg_path, thumb_url, base_strokes jsonb, base_texts jsonb,   -- 005: 수업 자료별 학습지
                unique(lesson_id, position) DEFERRABLE INITIALLY DEFERRED)   -- 없는 DB면 앱이 학습지 기능만 조용히 건너뜀(cloud.js wsTableMissing/snapHasWs)
session_participants(session_id, student_id, joined_at, pk(session_id, student_id))
slide_records(id, session_id fk cascade, slide_id, scope, scope_id NOT NULL /* whole → session_id */, strokes jsonb, texts jsonb, removed jsonb default '[]',
              last_writer, updated_at, unique(session_id, slide_id, scope, scope_id))
              -- v2.18.2: slide_id 꼬리 '~<묶음id>' = 묶음 행, '~@<기기id>' = 전체·모둠 쪽 기기 행(DB 변경 없음, §5.1)
responses(id bigserial, session_id fk cascade, slide_id, student_id, item_key default '', payload jsonb, score numeric, correct bool, time_ms int,
          last_writer, updated_at, unique(session_id, slide_id, student_id, item_key))
view lesson_meta(id, teacher_id, title, created_at, updated_at, slide_count, cover)   -- 006 이후에도 그대로(교과는 lessons.subject_id 를 따로 읽음)
realtime publication: sessions, session_participants, slide_records, responses   (lessons/slides/teachers/students 제외)
replica identity FULL: responses, session_participants (DELETE 이벤트에 old 전체)
storage bucket 'slides' public, 5 MB, image/jpeg|png|webp, anon select/insert/update/delete
```

### 3.3 Storage 경로 (캐시 무효화를 위해 쓰기마다 새 경로)

`<lessonId>/<slideId>_<Date.now().toString(36)>.jpg` (본 이미지), 같은 이름 + `_t.jpg` (썸네일 폭 320px).
업로드 옵션 `{ contentType: 'image/jpeg', cacheControl: '31536000', upsert: false }`. 교체 시 이전 path는 best-effort `remove`.
놓인 이미지(v2.10): `<lessonId>/<slideId>_img_<시각>.png|jpg` — 썸네일 없음, 긴 변 1600px, 투명 픽셀이 있으면 PNG(흰 배경 없음)·아니면 JPEG. 지우거나 바꿔도 파일은 지우지 않는다(스냅샷이 URL 참조). 자료 복제 시 새 폴더로 복사.

---

## 4. 모듈 구성과 소유권 (각 파일은 한 에이전트만 수정)

```
index.html              [D]  템플릿 최소화(§8), modulepreload, 폰트
styles.css              [D]  디자인 시스템 + 코어 레이아웃 (§7)
js/ui.js                [D]  el/mount/template/$/$$ 유지 + toast, confirmDialog, promptDialog, modal, sheet, icon, fmtDate, debounce
js/router.js            [A]  go() 같은 해시면 재디스패치, 라우트 cleanup
js/store.js             [A]  슬림 영속(§5.6)
js/sync.js              [A]  BroadcastChannel (로컬 모드 탭 동기화)
js/cloud.js             [A]  Supabase 어댑터 v2 (§5)
js/storage.js           [A]  이미지 업로드·썸네일·base64 이전
js/realtime.js          [A]  세션 채널: broadcast + presence (§5.4)
js/canvas.js            [I]  InkCanvas: stroke id, undo, destroy, 소수 4자리
js/lesson-view.js       [I]  renderSlide: 병합(tombstone), 디바운스 저장, dispose
js/zoom-view.js         [I]  필기 화면 확대·이동(핀치·휠·버튼), 내용 영역 맞춤 — renderSlide({ zoom:true })
js/pen-input.js         [I]  펜·손바닥 입력 공용(§6.3 '펜·손바닥'): 펜 우선·손바닥 판정·손가락 필기 설정·필기 화면 기본 동작 막기
js/lasso.js             [I]  올가미(v2.19, §6.3 '올가미'): 둘러싸 고르기·끌어 옮기기·색 바꾸기·지우기 — lesson-view가 씀
js/worksheet.js         [B/C] 학습지 공용(§9.5): wsPages·wsForced·setWsForce·wsStats(작성 중/작성함)·makeWsSessionView(개별 모드 Proxy)·wsTab(📝 탭)·CSS
js/slides/registry.js   [H]  레지스트리 + 헬퍼(effectiveMode, parseYouTubeId, groupStudents, fmtMs, shuffle, escapeHtml, newId)
js/slides/common.js     [H]  플러그인 공용 UI: activityBar, choiceBars, countdownPill, loadYouTubeApi, normalizeAnswer, optionLetter
js/slides/host.js       [H]  mountSlideHost + ctx (§6.2)
js/slides/index.js      [H]  모든 타입 import(등록). app.js가 import
js/slides/ink.js        [I]  필기 타입
js/slides/mcq.js short.js blank.js            [E1]
js/slides/wordcloud.js wall.js dragdrop.js    [E2]
js/slides/link.js embed.js video.js videoquiz.js  [E3]
js/slides/dino.js       [E4]
js/slides/race.js       [E5]
js/pptx.js              [B]  PowerPoint(.pptx) → 슬라이드 그림(캔버스, v2.15). storage.fileToSlides 가 동적 import
js/teacher.js           [B]  교사 대시보드·편집기·수업 진행·기록·학생·코드
js/student.js           [C]  학생 대기·수업 화면·내 기록
js/app.js               [C]  라우트·부트·로그인
```

---

## 5. 데이터 계층 API

### 5.1 cloud.js (모든 함수는 `isCloud=false`면 로컬 store로 동작하거나 no-op; 절대 throw로 앱을 죽이지 않는다. 실패는 `{ error }` 반환 또는 throw 후 호출부가 toast)

```js
export const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm'
export function cloudEnabled() → boolean
export function clientId() → string                 // 탭 단위, echo 억제
export const cloudReady: Promise<boolean>           // initCloud 완료 시 resolve (실패해도 false로 resolve)
export async function initCloud()                   // app.js가 1회 호출. supabase 클라이언트 생성 + 부팅 조회(§5.2)
export async function sha(s) → hex

// 교사
export async function cloudLoginTeacher(name, password) → { teacher } | { error: '비밀번호가 맞지 않아요' }
   // 서버에서 이름으로 조회 → 있으면 hash 비교, 없으면 신규 생성(joinCode 생성·unique 충돌 시 재시도 5회). store.teachers에 반영.
export async function cloudFindTeacherByCode(code) → teacher | null   // 서버 조회. 코드 정규화: upper, [A-Z0-9], 6자
export async function cloudBootTeacher(teacherId)   // §5.2 교사 부팅 조회 → store.lessons(meta)/sessions(meta)/students(참여자) 채움

// 학생
export async function cloudJoinStudent({ grade, classNum, num, name }) → student
   // upsert onConflict 'grade,class_num,num,name' → 반환 id를 정답 id로 채택. store.students에 반영. 로컬 모드는 로컬 생성.

// 수업 자료
export async function cloudFetchLessonSlides(lessonId, onProgress?) → Slide[]
   // 10장씩 .range 페이징. bg_url이 'data:'면 storage.js로 업로드 후 행 update(bg_url, bg_path)하고 URL로 치환(동시 ≤3).
   // onProgress(done, total). 결과를 store의 lesson.slides에 넣고 반환.
export async function cloudCreateLesson(lesson)     // lessons insert + slides(있으면)
export async function cloudSaveLesson(lesson)       // 제목·updated_at + slides 전체 저장. lesson별 직렬 큐, 대기 중 호출은 최신 인자로 합침.
   // ① slides upsert(onConflict 'id', 컬럼: id, lesson_id, position:i, type, title, config, bg_url, bg_path, thumb_url(=slide.thumb), mode, base_strokes, base_texts)
   // ② delete().eq('lesson_id').not('id','in', `(${ids})`)   ③ lessons update(title, updated_at)
export async function cloudDeleteLesson(lessonId)   // cascade. storage 폴더 best-effort 삭제.
export async function cloudDuplicateLesson(lessonId) → lesson   // (선택) 복제

// 세션
export async function cloudStartSession({ lesson, teacher }) → session | { error }
   // 1) lesson.slides 없으면 fetch  2) 0장이면 { error: '슬라이드를 먼저 추가하세요' }
   // 3) 기존 LIVE를 update({status:'stopped', ended_at}).eq('teacher_id').eq('status','live') 1회
   // 4) sessions insert(작은 행) + session_snapshots insert(slides) — 둘 다 await, 실패 시 sessions 행 delete 후 { error }
   // 5) store.sessions에 넣고 반환. 스냅샷 slide는 깊은 복사, ink slide의 strokes/texts 포함.
export async function cloudFetchLiveSession(teacherId) → session | null   // 학생 입장용: 행 + 스냅샷 + participants + responses + 내 records
export async function cloudFetchSession(sessionId, { forStudentId } = {}) → session | null
   // sessions 1행 + session_snapshots(없으면 레거시 slides_snapshot, 그것도 []면 lesson slides) + participants(+students 조인) + records + responses
   // records/responses는 fetchAll(1000행 페이징). 학생이면 records를 내 scope(내 id, 내 모둠, whole)로 한정.
   // store.sessions의 같은 id를 **in-place 교체**(객체 identity 유지: Object.assign) 후 반환
export function patchSession(session, patch)        // 교사 전용. Object.assign(session, patch); session.rev = Math.max(session.rev+1, Date.now());
   // 즉시 store.set + realtime send('session:patch', {rev, ...patch, sessionId}) + 150ms 디바운스 DB update(...).eq('id').lt('rev', rev)
   // patch 키: currentSlide, flow, groups, activity(전체 객체), status, endedAt. status 변경은 디바운스 없이 즉시 await.
export async function cloudEndSession(session, status /*'completed'|'stopped'*/)
export async function cloudResumeSession(session)   // 다른 LIVE stopped 처리 후 status live
export async function cloudDeleteSession(sessionId)
export async function cloudInsertSessionSlide(session, slide, index) → { index } | { error }
   // 교사: 스냅샷에 끼워 넣고 session_snapshots upsert(await) → patchSession({ activity: {...activity, __snap: ver}, currentSlide: index })
   // 받는 쪽: 패치·DB 행의 activity.__snap 이 세션의 _snapVer(비열거)와 다르면 스냅샷을 다시 읽은 뒤 그 패치를 적용.
   //          cloudFetchSession도 버전이 다르면 스냅샷을 다시 읽는다. 로컬 모드는 sync 'session:snapshot' 메시지.
export async function cloudListSessionsForStudent(studentId) → session[] (meta)   // 내 기록용
export function cloudEnsureReviewCode(session) → Promise<code|null>   // 없으면 만들어 채움(교사 코드와 겹치지 않게, unique 충돌 시 재시도). 열 없는 DB면 null
export async function cloudFindSessionByReviewCode(code) → { id, teacherId, status, title, teacher } | null

// 참여·필기·응답
export async function cloudAddParticipant(sessionId, studentId)
export function cloudWriteRecord(sessionId, slideId, scope, scopeId, rec)   // 키별 250ms 디바운스(최신만, 길어도 1초), whole이면 scopeId=sessionId
   // v2.18.2 (논설문 수업: 한 쪽 700 KB 한도에 막혀 '필기가 너무 많아요' 뒤 저장 안 됨 + 쪽 전체 재전송으로 DB 시간 초과 + 다시 맞추기가 옛 내용으로 덮어 글이 지워짐):
   //   · 크기 한도 없음. 획은 points 대신 pz(짧은 문자열, ink-codec.js — x·y 1/10000·p 1/100 정수 차이를 5비트 base64url 가변 길이로, 약 5배 작음).
   //     개별 쪽의 주인 학생 by·기본 tool 'pen'은 빼고 보낸다(풀 때 되살림). 이전 버전 화면은 points 없는 획을 건너뛴다(새로 고치면 보임)
   //   · 행 나누기: 개별 쪽 = 머리 행(<slideId>, 학생·첨삭 교사가 함께 씀). 전체·모둠 쪽 = 기기 행(<slideId>~@<기기id>, 그 기기가 만든 것만 — 남의 행을 쓰지 않음).
   //     행의 획(압축 JSON)이 48 KB를 넘으면 오래된 획(최근 12 KB는 남김)을 묶음 행(<slideId>~<묶음id>, ≤96 KB, 한 번 쓰고 안 바꿈)으로 먼저 옮기고
   //     행의 removed에 묶음 표시 '~<묶음id>'를 남긴다(메모리 Rec.removed에는 넣지 않음). 묶음이 실패해도 행은 다 실어서 쓴다
   //   · 실패하면 1·2·4·8·15초 …로 계속 다시 시도(실패 중 새 쓰기는 다음 시도에 실림, 재촉하지 않음). 3번 연속이면 toast 1회
   //     '인터넷이 느려 필기 저장이 늦어지고 있어요 · 계속 써도 연결되면 저장돼요', 되면 '필기를 저장했어요'. 수업이 지워짐(23503) 등은 그만두고 '필기를 저장하지 못했어요'
   //   · 저장이 1.5초 넘게 안 끝나면 저장할 내용을 localStorage 'hada:rq:<키>'에 보관 → 저장되면 지움. 다음 cloudFetchSession이 병합하고 서버에 없으면 다시 저장(3일 뒤 버림)
   //   · v2.19: 행의 지운 표시가 400개를 넘으면(올가미로 자주 옮기기·많이 지우기) 최근 120개만 남기고 나머지를 묶음 행(strokes [], removed […])으로.
   //     읽는 쪽은 묶음 행의 removed도 합친다. 큰 덩어리(획 300개)를 40번 옮겨도 머리 행 ≈ 50 KB
export async function cloudSubmitResponse(r /* Response without id */) → Response   // upsert onConflict 'session_id,slide_id,student_id,item_key' .select().single()
export async function cloudDeleteResponse(sessionId, slideId, studentId, itemKey)
export async function cloudDeleteResponsesForSlide(sessionId, slideId)              // 교사 '초기화'/'다시'
export async function cloudFetchResponses(sessionId) → Response[]

// 구독
export function subscribeSession(sessionId, { role, studentId, groupId }) → unsubscribe
   // 토픽 'db:session:<id>'. postgres_changes:
   //   sessions filter id=eq.<id>                  → rev 비교 후 in-place 반영(snapshot 제외)
   //   session_participants filter session_id=eq.  → participants 증분(+학생 정보 없으면 1회 조회)
   //   responses filter session_id=eq.             → INSERT/UPDATE: (slide_id,student_id,item_key) 교체, DELETE: old.id로 제거
   //   slide_records: 교사 filter session_id=eq.<id>; 학생 filter scope_id=in.(<studentId>,<groupId|none>,<sessionId>)
   //   → applyRecord: last_writer===clientId면 무시. 모든 scope가 id 기준 합집합 병합 + removed 합집합(글은 ts·없으면 at가 새 것) — v2.18.2부터 individual도
   //     병합(예전엔 원격 채택이라 저장 안 된 내 필기가 다시 맞추기 때 지워졌다). 머리·기기·묶음 행을 한 Rec로 합치고, 모르는 묶음 표시는 그 행만 조회(fetchSegments).
   //     개별 쪽 머리 행에서 내 항목이 빠졌으면 0.3~1.3초 뒤 다시 씀(남의 것은 그 주인이). 전체·모둠은 각자 자기 행이라 수렴 쓰기 없음.
   //   cloudFetchSession은 필기 행을 100행씩 읽고 묶음 행 → 나머지 순으로 반영, 끝에 기기 보관분 병합. 학생의 재연결 resync는 0.3~1.8초 흩어서.
   // SUBSCRIBED 재진입(재연결) 시 resync = cloudFetchSession. visibilitychange(visible)·online 이벤트에도 resync(500ms 디바운스).
   // 모둠 변경 시 학생은 unsubscribe 후 재구독.
export function watchTeacherLive(teacherId, onLive /*(sessionMeta)*/) → stop   // 학생 대기: sessions filter teacher_id=eq + 5초 폴링
```

- 모든 쓰기에 `last_writer: clientId()` 포함. v1의 `hada:lw_*` localStorage 키는 initCloud에서 삭제.
- `fetchAll(build, page=1000)` 헬퍼로 1000행 한도 회피.
- 조회 컬럼은 명시(select('*') 금지): 특히 `sessions`는 `slides_snapshot` 제외, `teachers`는 남의 `password_hash` 제외.

### 5.2 부팅 (initCloud)

- 공통: 클라이언트 생성, `localStorage.removeItem('hada:lw_sessions'|'hada:lw_records')`.
- `whoTeacher` 있으면 `cloudBootTeacher(id)`:
  - `teachers.select('id,name,join_code,password_hash').eq('id', tid).maybeSingle()` (없으면 whoTeacher=null)
  - `lesson_meta.select(...).eq('teacher_id', tid).order('updated_at', desc)` → lessons(meta, slides:null 유지; 이미 불러온 slides는 보존)
  - `sessions.select('id,lesson_id,teacher_id,title,status,flow,current_slide,groups,activity,rev,started_at,ended_at').eq('teacher_id', tid).order('started_at', desc).limit(200)`
  - `session_participants.select('session_id,student_id,students(id,grade,class_num,num,name)').in('session_id', ids)` (200개씩)
- 학생: 부팅 조회 없음(입장 흐름에서 조회).
- 로컬 모드: store 그대로.

### 5.3 storage.js

```js
export async function uploadSlideImage(lessonId, slideId, blobOrDataUrl) → { url, path, thumb }   // 본+썸네일 업로드. 로컬 모드: dataURL 그대로 반환
export async function removeSlideImage(path)
export async function fileToSlides(file, lessonId, onProgress) → Slide[]   // PDF(pdf.js 4.0.379, scale 1.6, jpeg 0.85)·PowerPoint(.pptx, js/pptx.js)·이미지 → ink 슬라이드(업로드 완료된 URL)
export async function uploadPlacedImage(lessonId, slideId, blob) → { url, path, ar }   // 슬라이드 위 이미지(v2.10). 로컬 모드: dataURL
export async function copySlideImage(path, lessonId, slideId, { tag, thumb }) → { url, path, thumb } | null   // 자료 복제용, 확장자 유지
export function isDataUrl(s)
```

### 5.4 realtime.js (토픽 `rt:session:<id>`, cloud.js의 `db:` 채널과 분리)

```js
export function joinSessionChannel(sessionId, me /*{id, name, role:'teacher'|'student'}*/) → ch
ch.send(event, payload)            // broadcast, self:false. 로컬 모드: BroadcastChannel
ch.on(event, cb) → off              // cb(payload)
ch.online() → Set<studentId>        // presence(role student) — 100ms 디바운스 갱신
ch.recent() → Set<studentId>        // v2.13: online ∪ 끊긴 지 10초 안 된 학생(교사 화면 '접속 중 먼저' 순서용 — 잠깐 끊겼다 붙어도 출렁이지 않게)
ch.onPresence(cb) → off             // 유예가 끝날 때도 한 번 더 불린다
ch.leave()
export function currentChannel() → ch | null   // 현재 세션 채널 (host가 사용)
```
- presence key = me.id, track `{id, name, role}`는 SUBSCRIBED 직후 **1회**.
- **메시지 예산**: 채널 송신 합계 ≤ 20 msg/s. 브로드캐스트는 **이산 이벤트만**(위치 스트림 금지). 이벤트 이름 `'<type>:<evt>'`.
- 코어 이벤트: `session:patch {sessionId, rev, ...patch}`(교사→전원), `session:hello {}`(학생 입장 직후 → 교사가 현재 상태 전체로 `session:patch` 응답).
- 수신 측은 `patch.rev > session.rev`일 때만 적용(늦은 DB 이벤트가 되돌리지 않게, DB 이벤트도 같은 비교).

### 5.5 router.js

- `go(path)`: 대상 해시가 현재와 같으면 `dispatch()` 직접 호출.
- 라우트 핸들러 반환 cleanup을 다음 dispatch 전에 호출(이미 그렇게 동작 — 유지). 모든 뷰는 cleanup을 반환해야 한다.

### 5.6 store.js

- 상태: `{ teachers, students, lessons, sessions, whoTeacher, whoStudent, studentProfile /* 기억된 학생 {id,grade,classNum,num,name,lastCode} */ }`
- `store.set(updater)` → 리스너 즉시 호출, **저장은 300ms 디바운스**.
- 클라우드 모드 저장 대상: `whoTeacher, whoStudent, studentProfile, teachers, students` + lessons meta(slides 제외) + sessions meta(records/responses/slidesSnapshot 제외). 로컬 모드: 전체 저장(v1과 같음, 단 한도 초과 시 bg 제거하지 말고 저장 생략 + console.warn).
- 기존 키 `hada:v1` 유지, 레거시 `inkclass:v1` 이전 유지.
- helper: `findLesson(id)`, `findSession(id)`, `findStudent(id)`, `studentLabel(s)`(`6-2-14 홍길동`), `newId(prefix)`, `newJoinCode()`.

---

## 6. 슬라이드 타입 플러그인

### 6.1 registry.js (이미 존재 — H가 헬퍼 추가)

`registerSlideType(def)`, `getSlideType(type)`, `listSlideTypes()`, `createSlide(type, extra)`, `CATEGORIES`, `injectCss(key, css)`, `newId`, `shuffle`, `fmtMs`, `escapeHtml` + 추가:
```js
export function effectiveMode(slide, session)          // §3.1
export function parseYouTubeId(url) → id | null        // watch?v=, youtu.be/, shorts/, embed/, live/
export function groupStudents(ids, maxSize = 4) → string[][]   // shuffle 후 g=ceil(n/max), 앞 n%g 조는 floor(n/g)+1명. 7→[4,3], 5→[3,2], 9→[3,3,3], 10→[4,3,3]
```

def 계약(registry.js 상단 주석이 원문):
```js
def = {
  type, category: 'basic'|'interact'|'media'|'game', label, desc /*title 속성용*/, icon /*24px stroke SVG 문자열*/,
  create() → Slide            // id·type·title은 createSlide가 채움. config 기본값 포함.
  thumb?(slide) → HTMLElement // 없으면 아이콘+제목 기본 썸네일
  Editor({ slide, lesson, update, ctx }) → { el, destroy? }
  Student({ slide, session, me, ctx }) → { el, destroy?, onActivity?, onResponses?, onSession? }
  TeacherLive({ slide, session, ctx }) → { el, destroy?, onActivity?, onResponses?, onSession?, panel?, actions? }
      // panel = 수업 진행 레일 '도구' 패널 내용(있을 때만 '도구'가 보임), actions = 코어 화면이 부르는 동작 { 이름: fn } (ink: { groups })
  summary?(slide, responses, session, ctx) → HTMLElement      // 기록 화면(읽기 전용)
  validate?(slide) → string|null   // 편집기 경고 문구(예: '정답을 선택하세요'), 시작 시에도 표시
}
```
- `update(patch)`: 코어가 **얕은 병합** `Object.assign(slide, patch)`. `config`를 바꿀 때는 플러그인이 **전체 config 객체**를 넘긴다(`update({ config: { ...slide.config, question } })`). 코어가 300ms 디바운스 저장 + 썸네일 갱신.
- Editor 폼 규칙: 세로 1열, 각 입력은 `.field`, placeholder만(설명 문단 금지). 옵션 추가/삭제는 `.btn-sm`/`.btn-icon`.

### 6.2 host.js — `mountSlideHost`

```js
mountSlideHost({ role /*'student'|'teacher'|'editor'*/, root, slide, session, me, lesson, onEditorUpdate, sessionView? })
// sessionView(session) → 플러그인에게 보여 줄 세션(학생 복습: 활동 상태·모드만 바꾼 Proxy). 응답·필기 쓰기는 진짜 세션에.
  → { update({ slide, session }), destroy(), panel /*TeacherLive.panel|null*/, actions /*TeacherLive.actions|null*/, ctx }
```
- 키 `${slide.id}|${role}` 가 같으면 DOM 보존: `onActivity(state)`(activity[slide.id]가 바뀌었을 때, JSON 비교), `onResponses(list)`(responses[slide.id] 배열이 바뀌었을 때), `onSession(session)`(그 외 모든 세션 변경 — 싸고 멱등이어야 함)만 호출. 키가 바뀌면 `destroy()` 후 재마운트.
- 플러그인 예외는 try/catch로 감싸 `.empty` 메시지('이 슬라이드를 불러오지 못했어요')로 대체(앱 전체가 죽지 않게).
- `destroy()`: 플러그인 destroy + ctx.on으로 등록된 리스너 전부 off + 타이머 정리.

ctx (role별):
```js
ctx = {
  role, isTeacher, me /* teacher|student */, slide, session() /* 항상 store의 최신 객체 */,
  students() → Map<id, student>, participants() → id[], online() → Set<id> /*학생 측 빈 Set*/,
  activity() → ActivityState /* 기본 {phase:'idle'} */,
  setActivity(patch)            // 교사 전용: activity[slide.id] = {...prev, ...patch} → patchSession. 학생 측 no-op + warn
  responses() → Response[]      // 이 슬라이드 전체(학생 측도 전체: 클라우드/담벼락 표시용)
  myResponse(itemKey='') → Response|null
  submit(payload, { itemKey='', score=null, correct=null, timeMs=null }) → Promise<Response>
      // 학생: 로컬 즉시 반영(음수 임시 id) → cloudSubmitResponse → id 치환. 실패 시 toast('제출 실패, 다시 시도해 주세요') 후 throw.
      // 교사 측 호출 시 no-op.
  removeResponse(studentId, itemKey) → Promise   // 교사: 아무거나 / 학생: 자기 것만
  clearResponses() → Promise                     // 교사: 이 슬라이드 응답 전부 삭제
  send(event, payload), on(event, cb) → off      // realtime 채널. destroy 시 자동 off
  groups() → group[], myGroup() → group|null
  toast(msg), confirm(msg, { ok='확인', danger=false }) → Promise<boolean>, modal(opts)
  injectCss(key, css)
}
```
- 에디터 role의 ctx: session 관련 함수는 빈 값/no-op.

### 6.3 공통 활동 규칙 (모든 응답형·게임 타입)

- **응답형(mcq, short, blank, wordcloud, dragdrop, wall)**: 학생은 슬라이드에 도달하면 **바로 응답 가능**(`phase:'idle'` = 받는 중). `'ended'` = 마감(입력 잠금, pill '마감'). `'running'` = 타이머 진행 중. 마감 전까지 재제출(upsert) 가능. `reveal:true`면 학생에게 정답/결과 공개.
- **교사 공통 바** `activityBar(ctx, { reveal: bool, timer: bool })`(common.js): `응답 12/25` · `[마감]`↔`[다시 받기]` · `[정답 공개]` 토글(reveal 옵션 시) · `[타이머]`(timer 옵션 시, 프리셋 30/60/90/120초 sheet) · `[초기화]`(confirm → clearResponses, phase idle, reveal false). 반환 el은 `.update()` 메서드를 가진다(onActivity/onResponses에서 호출).
- **타이머**: `setActivity({ phase:'running', startedAt, endsAt })`. 학생·교사 모두 `countdownPill(endsAt)`(10초 이하 빨강). `endsAt` 도달 시 **교사 클라이언트**가 `setActivity({ phase:'ended' })`, 학생은 로컬로도 잠금.
- **결과 가리기(v2.9)**: 정답이 있는 활동(mcq·blank·dragdrop·short·videoquiz)의 교사 화면(칠판에 띄움)은 마감·정답 공개·타이머 끝(`common.resultsOpen`) 전에는 결과(막대·인원·학생별 답·도구 패널의 답)를 가리고 `resultsVeil`(큰 응답 수 `n / m명 응답` + 진행 막대 + '마감하면 결과가 보여요')만 보인다. mcq는 선지 타일은 그대로(`columnChart.update({ veiled })`). '전원 응답 → 자동 공개'는 없앴다(결과는 늘 교사가 연다). 학생 mcq 정답 표시도 공개·마감 뒤에만. videoquiz는 문제마다 [정답 공개]·지나감(교사 진행) 또는 [마감](자율) 뒤.
- **문제 그림(v2.9)**: `config.image`(문제가 여럿이면 `q.image`) = `{ url, path, thumb }`. 편집기 `common.imageField`(`questionEditor({ image, imageAt:{ lessonId, slideId } })`에도 내장) → `storage.uploadSlideImage`(수업 자료 폴더). 화면 `common.questionImage`(누르면 크게, 기록은 작게). 모든 상호작용·게임 타입(mcq·poll·short·blank·wordcloud·dragdrop·wall·videoquiz·dino·race). 자료 복제 때 `cloud.copyConfigImages`가 config 안의 모든 image를 새 폴더로 복사. 그림을 올리는 중이면 팝업·수업 중 추가 창의 저장을 막는다.
- **게임(dino, race)**: `phase:'running'`일 때만 플레이. 교사 `[시작]`(idle→running) / `[종료]`(→ended) / `[다시]`(clearResponses → idle). 결과 `submit(payload, { itemKey:'result', score, correct, timeMs })`. TeacherLive = 리더보드.
- 교사가 `running` 중인 게임 슬라이드에서 다른 슬라이드로 이동하면 teacher.js가 `confirmDialog('게임을 종료하고 넘어갈까요?')` → 예: `ended`로 만든 뒤 이동(코어 규칙: `def.category==='game' && activity.phase==='running'`).

#### 필기 확대·이동 (v2.4)
- 필기 화면(편집기 · 교사 전체 · 학생 · 학생 필기 크게 보기)은 `renderSlide({ zoom:true })`. 스테이지가 보기 영역이고 프레임(배경·텍스트)은 확대된 실제 크기로 배치(원본 해상도로 다시 그려 선명), 캔버스는 보기 영역 크기 비트맵 + `InkCanvas.setView({ox,oy,cw,ch,baseW})`(확대해도 선명·메모리 일정). 제스처 중엔 GPU transform 미리보기 → 손을 떼면 확정.
- 맞춤: 배경이 세로(가로/세로 ≤ 1.25)면 썸네일을 분석해 흰 여백을 뺀 내용 영역이 화면에 꽉 차게(내용이 종이의 25% 미만이거나 읽을 수 없으면 종이 전체). 이동은 종이 안에서만. 회전·크기 변화 시 맞춤 상태면 다시 맞춤.
- 입력: 펜·마우스 = 필기, 한 손가락 = 필기(이 기기에서 펜을 한 번 쓰면 손가락 필기는 꺼짐 — 아래 '펜·손바닥'), 두 손가락 = 확대·이동, 읽기 전용·텍스트 도구는 한 손가락/마우스 끌기 = 이동, Ctrl(⌘)+휠·트랙패드 핀치 = 확대, 휠 = 이동. 확대 배율 1(16:10 전체) ~ 맞춤×4. 지우개 반경은 확대 배율만큼 줄인다. 선 굵기: 획은 쓸 때 배율 `zw`를 기억하고 `size = 펜 값 ÷ zw`(슬라이드 위 실제 굵기)로 저장. 확대·이동 화면은 `size × min(보는 배율, zw)` — 쓸 때 배율에선 쓸 때 본 굵기, 축소하면 글씨와 함께 가늘어지고(굵어 보이지 않음), 더 확대해도 쓸 때보다 굵어지지 않음. 기록·썸네일·인쇄·갤러리는 실제 굵기(그림 폭/960, 최소 0.6~0.7px). zw 없는 이전 획은 zw = 1. 제스처 중에도 획 점이 6000개 이하면 매 프레임 다시 그려 굵기가 출렁이지 않음. 확대해서 만든 텍스트만 배율로 나눈 글자 크기로 저장(화면에서 보이는 크기 유지, 최소 2).
- 학생 화면: 스테이지 여백 0, 도구바가 덮는 만큼만 맞춤에서 비움(이동하면 도구바 뒤로도 보임). 가로로 남는 화면이면 도구바를 왼쪽 세로 2열로(낮은 화면은 40px 버튼). 도구바에 `[− 100% +]`(100% = 맞춤, 누르면 맞춤 ↔ 폭 맞춤). 발표(읽기 전용)·교사 화면은 오른쪽 아래 작은 확대 버튼. 필기 화면에서는 페이지 자체 확대를 막는다(`.stu:has(.zoom-view)`).
- 교사 갤러리 보기 `[필기 부분 | 전체]`(기기에 기억, 기본 필기 부분): 필기 부분 = 칸마다 그 학생이 방금 쓰는 곳(최근 20초·최대 12개 획/글자, 교사 첨삭 제외)을 16:10 칸에 확대(최대 2배, 줄 시작부터 필기 끝이 학습지 폭 80% 안이면 왼쪽부터 보여 문제 글이 함께 보임). 가운데 15%·크기 20% 미만 변화는 무시(흔들림 방지), 옮길 때 살짝 페이드. 필기가 없으면 학습지 전체. 칸 필기는 칸 크기 × dpr 캔버스에 보이는 영역만(`paintStrokes({ region, lineK })`, 선 굵기는 칸 폭 기준 고정).
- 교사 갤러리(개별·모둠): 칸 크기를 인원·화면에 맞춰 계산 — 모두 한 화면에 들어오는 배치 중 가장 큰 칸, 그 칸이 200px보다 작아지면 200px 이상으로 두고 스크롤. 칸은 학습지 내용 영역만 잘라 보여 주고(`pageRectFor`, 가로 슬라이드는 전체), 필기 캔버스는 칸 실제 크기 × dpr(최대 2400px).
- 가져오기 해상도: PDF·이미지 긴 변 세로 3000px / 가로 2400px(PDF 배율 1.6~4). 이전에 올린 자료(배율 1.6)는 다시 올려야 선명해진다.
- **PowerPoint(.pptx, v2.15)**: 서버 없이 `js/pptx.js`가 브라우저에서 그린다 — fflate 0.8.2(jsDelivr ESM)로 압축 풀기 + DOMParser. 숨긴 슬라이드 제외, 장마다 캔버스(가로 2400px · 세로 슬라이드는 높이 3000px) → PDF 쪽과 같은 인코딩·업로드(`pagesToSlides`, 동시 3개).
  그리는 것: 배경(단색·그라데이션·그림·바둑판·두 색 효과), 그림(자르기·투명도·도형 모양 잘라내기), 도형(사각·둥근 사각·원·삼각형·마름모·평행사변형·사다리꼴·오각·셰브런·육각·팔각·십자·화살표·별·하트 + 자유형), 선·연결선(점선·화살촉), 글자(크기·굵게·기울임·밑줄·취소선·위·아래 첨자·대문자·색·글꼴, 정렬·들여쓰기·줄·문단 간격·글머리·번호, 자동 맞춤(넘치면 줄임)·세로 맞춤·여백·세로쓰기 회전), 표(파일의 표 스타일, 없으면 PowerPoint 기본처럼), 그룹(회전·뒤집기), SmartArt(파일에 저장된 그림 drawing*.xml, 글자는 거꾸로 서지 않게), 개체 틀 상속(레이아웃 → 마스터, idx 먼저 · 없으면 종류), 테마 색·글꼴·스타일 참조(fillRef·lnRef·fontRef), clrMap 덮어쓰기.
  그리지 않는 것: 차트(옅은 '차트' 상자), 동영상(표지 그림만), 그림자·3D·애니메이션, EMF·WMF·TIFF 그림. 없는 글꼴은 Pretendard → 줄바꿈이 조금 다를 수 있다. 한글은 어절 단위로 줄바꿈(한 어절이 칸보다 길면 글자 단위). 옛 .ppt·.key 는 '.pptx나 PDF로 저장해서 올려 주세요' 안내.

#### 올가미 (v2.19, js/lasso.js · canvas 12 · lesson-view)
- 도구바 **올가미**(지우개 다음, 교사·학생·편집기 공통): 옮길 획·글 상자를 둘러싸 그리면 점선 상자로 고르고, 상자 안(둘레 14px 여유)을 끌면 옮겨짐(종이 밖으로는 안 나감), 놓으면 저장.
  상자 위 막대 `n개 · 🗑 · ✕`(위 끝이면 아래), 도구바 색 = 고른 것을 그 색으로(도구는 올가미 그대로), 빈 곳 톡·✕·Esc = 해제, Delete·Backspace = 지우기. 되돌리기는 옮기기·색·지우기를 작업 하나씩.
- 고르는 기준: 획은 점(최대 24개 고르게)의 절반 이상이 올가미 안, 글 상자는 가운데가 안. 편집기 기본 필기(바닥 레이어)는 고르지 않는다(지우개처럼 원본 보호). 입력 규칙은 펜과 같다(펜·마우스, 손가락은 손가락 필기가 켜졌을 때만, 두 손가락 = 확대·이동, 펜 지우개 끝은 지우개).
- 데이터: 획은 바뀌지 않는 값 → 옮기기·색 바꾸기는 옛 id를 지운 표시로, 새 id 획(새 ts — 맨 위)으로 다시 만든다(병합·묶음 행이 id로 합쳐도 겹치지 않음, 이전 버전 화면도 그대로 이해). 글 상자는 같은 id에 x·y·ts(·색, 부분 색은 지움)만. edit scope는 slide.strokes를 바로 바꿈.
  되돌리기 = 지금 그 획(옮겨질 때마다 InkCanvas alias로 새 id를 따라감)을 원래 모양의 새 id 획으로, 지우기 되돌리기 = 지운 것을 새 id로 다시.
- 최적화: 고르는 순간 고른 획을 '떠 있는 층'으로(고른 획을 뺀 캐시 다시 그리기 + 고른 획 비트맵, 한 번). 끄는 동안 프레임마다 그림 2장, 놓아도 비트맵을 그대로 두고 자리만 기억(`replaceStrokes shift`), 풀 때 비트맵을 캐시에 찍어 넣음 →
  획 1,564개 쪽에서 581개를 골라 끌기·놓기·다시 끌기·풀기 동안 획 다시 그리기 0번(고를 때만 한 번). 형광펜이 섞였거나 고른 뒤 바꾸지 않았으면 풀 때 캐시를 다시 그림(쌓인 순서·섞는 방식 그대로).
- 도구바 폭: 버튼이 하나 늘어 세로 태블릿 한 줄 규칙을 다시 맞춤 — 1100px 이하 도구 42px, 521~860px 도구 38·크기 32·색 29px, 521~790px 도구 35px(높이는 모두 44px). 744·768·800·820·834·860·879·940·1024·1366px에서 한 줄.

#### 펜·손바닥 (v2.6.1, js/pen-input.js · zoom-view · canvas · lesson-view)
- **원인(이전)**: ① 손바닥(터치)이 펜보다 먼저 닿으면 InkCanvas가 그 터치를 '첫 포인터'로 잡아 선을 긋고 펜을 무시 ② 손바닥 접점 둘 = 두 손가락 확대·이동 → 화면이 끌리고 그동안 펜도 막힘 ③ 길게 누르기·S펜 옆 버튼·Chromebook 길게 누르기 = 오른쪽 클릭 메뉴, 펜으로 끌면 글자 선택·끌어 놓기(막는 처리 없음) ④ 텍스트 상자가 펜 도구일 때도 편집 가능 → iPad Scribble이 근처 필기를 가로챔.
- **펜 우선**: 펜이 닿는 순간 이미 닿아 있던 터치는 모두 손바닥(뗄 때까지 무시). 그 터치가 긋던 선은 버리고, 그 터치로 시작된 확대·이동은 그 자리에서 멈춘다(되돌리지 않음 — 사용자는 보이는 화면에 펜을 댔다). 펜이 닿아 있거나 뗀 뒤·띄워 둔(호버) 뒤 600ms 안에 닿는 터치도 손바닥. 펜 기기에서 접촉면(가로·세로 중 큰 쪽)이 90px 이상인 터치도 손바닥.
- **손가락 필기 설정**(기기 localStorage `hada:penMode`): 없음 = 자동(손가락 필기), 펜을 처음 쓰면 'pen'(손가락은 두 손가락 확대·이동만) + toast 1회. 도구바 끝 **✋**(펜 기기에서만 보임, 꺼짐 = 빗금)로 'touch'(손가락도 필기) ↔ 'pen'.
- **확대·이동 문턱**: 펜 기기에서는 두 접점이 10px 넘게 움직여야 확대·이동이 시작(얹어 둔 손이 화면을 흔들지 않게), 시작점은 그때 위치로. 움직이지 않은 두 접점 중 하나를 떼면 아무 일 없음.
- **손바닥 탭 버리기**: 펜을 쓰는 동안 닿아 있던 터치(또는 펜이 닿아 있을 때 닿은 터치·큰 접촉면)가 떼어질 때의 click은 800ms 안·같은 요소면 버린다(도구바 아래쪽에 손을 얹고 써도 도구가 바뀌지 않게). 펜 탭·마우스 클릭·그 뒤 펜을 뗀 경우는 그대로.
- **브라우저 기본 동작**: 필기 화면(`.stu .live .editor .ink-wrap .zoom-view .ws-view .ws-tab`)에서 contextmenu·dragstart를, 필기 면·도구바에서 selectstart를 막는다(입력칸·편집 중 글자·링크 제외). 캔버스에서 시작한 touchstart·touchmove는 preventDefault(iPad Safari 길게 누르기 글자 선택·확대경·콜아웃·두 번 탭 확대 차단, 포인터 이벤트는 그대로). CSS: 위 화면 `-webkit-user-select:none; -webkit-touch-callout:none`(입력칸은 text), 이미지 `-webkit-user-drag:none`, `.stu .live .editor` `touch-action: manipulation`(필기 화면이 있으면 `pan-x pan-y`), `html:has(.zoom-view)` `overscroll-behavior: none`, 도구바 `touch-action: manipulation`.
- **텍스트 상자**: 텍스트 도구일 때만 `contenteditable`(그 밖에는 "false") — Scribble이 펜 필기를 글자 입력으로 가로채지 않게.
- **텍스트 상자 옮기기·크기(v2.8, 학생·교사 공통, lesson-view)**: 텍스트 도구에서 글자 칸을 누르면 선택 테두리(프레임 비율 %로 배치 — 확대·맞춤에도 어긋나지 않음). 왼쪽 위 ✥ 끌기 = 옮기기(칸 전체가 프레임 안), 오른쪽 아래 ↘ 끌기 = 칸 크기(`t.w` 폭·`t.h` 최소 높이, 프레임 비율), 위 막대 `가− 크기 가+ 🗑`(×1.2 단계, 2~160). 선택한 칸은 도구바 색·S/M/L도 따른다. 손을 뗄 때 저장(`ts` 갱신 → 병합에서 최신이 이김). 손잡이·막대는 pointerdown preventDefault로 입력 중인 글자 칸 포커스를 지키고, 그 사이 빈 칸은 지우지 않는다. 미니·기록·인쇄는 `canvas.js drawTextBox`로 같은 칸 폭에서 줄바꿈(t.w 없으면 min(70%, 오른쪽 끝)).
- **구형·저사양 태블릿(v2.8, 갤럭시탭 S6 Lite 등)**: 학습지 화면이 검게 덮이거나 윤곽만 깜빡이던 문제 — ① 저지연 캔버스(`desynchronized`)는 앞 버퍼에 바로 그려 일부 안드로이드 GPU(Mali)에서 투명 캔버스가 검게 보이거나 지우고 다시 그리는 순간이 보임 → 크롬북에서만 켬(기기 강제: localStorage `hada:lowLatency` `1`/`0`). ② 안드로이드 크롬 '웹페이지 어둡게'·삼성 인터넷 다크 모드가 흰 학습지 이미지를 반전 → `color-scheme: only light`(meta·`:root`·프레임) + `prefers-color-scheme: dark` 규칙. ③ 캔버스 비트맵 한 변 4096·1200만 화소 이하, `contextrestored`에 다시 그림, 크기를 아직 못 잰 캔버스의 확대 배율은 1(글자·획이 수백 배로 커지던 문제). ④ `js/compat.js`(Object.hasOwn·structuredClone·Array.at 보완), cqw 미지원이면 글자 크기 px 계산. ⑤ 학습지 앞뒤 쪽 배경 미리 받기(`wsPrefetch`).
- **펜 버튼**: 펜 지우개 끝(button 5 / buttons 32)·옆 버튼(S펜 등 button 2 / buttons 2)을 누른 채 그으면 그 획은 지우개.
- **그리기 최적화(canvas 8)**: 그리는 중인 펜 획은 모양이 정해진 구간(i ≤ 점 수 − 3)을 캐시에 바로 그려 두고 매 프레임 끝 구간만 다시 그림(획이 길어도 프레임 비용 일정, 결과는 통째 그리기와 같은 픽셀). 예측 점(getPredictedEvents, 40px 이내 1개)으로 펜 끝을 앞서 그림(저장 안 함). 화면 0.6px 안쪽 점은 버림(저장 크기 감소). 좌표 계산의 레이아웃 읽기는 이벤트 묶음마다 1번.
- **세로 태블릿 도구바**: 폭 ≤940px에서 아래 도구바 버튼 폭 40px·색 36px, ≤790px에서 37px·32px(높이 44px 유지) → 744~834px에서 ✋까지 한 줄에 들어감(이전에는 810px에서도 확대 버튼이 잘렸다).

### 6.4 타입별 상세

| type | label | category | config 기본값 |
|---|---|---|---|
| ink | 필기 | basic | `mode:'whole', bg:null, strokes:[], texts:[]` (config `{}`) |
| mcq | 객관식 | interact | `{question:'', options:[{id,text:''}×4], answerIds:[], multiple:false, timerSec:null}` |
| poll | 설문 | interact | `{question:'', options:[{id,text:''}×4], multiple:false}` (정답 없음) |
| short | 주관식·서술형 | interact | `{question:'', long:false, maxLen:300}` |
| blank | 빈칸 채우기 | interact | `{text:'', caseSensitive:false}` |
| wordcloud | 워드클라우드 | interact | `{prompt:'', maxWords:3}` |
| dragdrop | 분류하기 | interact | `{prompt:'', buckets:[{id,label:'A'},{id,label:'B'}], items:[{id,text:'',bucketId}×4]}` |
| wall | 담벼락 | interact | `{prompt:'', allowColor:true, showNames:true}` |
| link | 웹 링크 | media | `{url:'', title:''}` |
| embed | 임베드 | media | `{html:'', src:''}` |
| video | 동영상 | media | `{url:'', playMode:'teacher'}` |
| videoquiz | 동영상 퀴즈 | media | `{url:'', questions:[]}` |
| dino | 공룡 점프 | game | `{questions:[{…, sec:20}], jumpsPerQuestion:3, passPct:80, holdWrong:true}` |
| race | 레이싱 퀴즈 | game | `{questions:[{…, sec:20}], laps:2, passPct:80, holdWrong:true}` (옛 `quizSec` = sec 없는 문제의 기본값) |

**ink** (`js/slides/ink.js`)
- 모드: `none`(발표) 학생 readOnly — **교사 필기는 whole scope에 저장되어 학생에게 실시간 표시**; `whole` 모두 같은 캔버스(scope whole); `individual` 학생 각자(scope individual/studentId); `group` 모둠 공유(scope group/groupId), 미배정 학생은 `모둠을 기다리고 있어요` 한 줄 → 배정되면 자동 전환.
- Student: 캔버스 + (쓰기 가능 모드에서만) 하단 플로팅 도구바: 펜·형광·지우개·텍스트 | 색 6 | 굵기 S/M/L | 되돌리기. 모드 바뀌면 재마운트(키에 모드 포함 — ink는 자체적으로 onActivity에서 scope 키 비교 후 내부 재마운트).
- TeacherLive: 스테이지 = 캔버스(none/whole → whole scope에 교사 필기, 도구바 동일 + `전체 지우기`). individual/group → 스테이지는 배경만 + **갤러리**(학생/모둠 타일 그리드, 이름·온라인 점·미니 캔버스, 레코드 변경 시만 다시 그림) — 타일 탭 → 모달로 크게(교사 첨삭 가능, 해당 scope에 기록). panel 없음(v2.7 — 모드 seg는 수업 진행 상단 바에만). `actions.groups()` = 모둠 편성 창(상단 바 [모둠] 버튼이 부름).
  - 도구바 자리(v2.18, whole 캔버스): `placeBar` — 위 가로(흐름 안, 늘 쓰던 자리) / 왼쪽 세로 2열(`.ink-float` + wrap `bar-side`, 위에 붙임 `top:8px`, H<560이면 `bar-compact` 40px) 중 맞춤 대상이 더 크게 보이는 쪽(세로 2열은 H≥460이고 4% 넘게 클 때). 세로 2열이면 `zoom.setInsets({ left })`. 확대 `[− % +]`는 도구바 안(`makeToolbar({ zoom:true })`) — 따로 뜨던 `zoomPill`은 교사 whole에서 없앰. `[전체 지우기]`는 세로 2열에서 두 칸 폭 맨 끝. ResizeObserver(wrap)·`zoom.onChange("page")`로 다시 고름.
- **모둠 편성 모달**: 조 크기 seg `2·3·4·5`(기본 4) + `[랜덤 편성]`(groupStudents(online∪participants, size)) + 칩 **탭→탭** 이동(드래그 금지). 저장 = `patchSession(session, { groups })`.
- Editor: 스테이지에 캔버스 + 도구바(교사 기본 필기), 인스펙터(코어)에 배경 교체·기본 모드 seg를 ink가 `inspector` 필드로 제공(`Editor()` 반환에 `inspector?: HTMLElement` 허용).
  - 도형(v2.10, 모든 화면): 도구바 **도형** — 누르면 종류 창(직선·화살표·네모·동그라미·세모), 켜진 도구를 다시 누르면 다시 연다. 끌어서 그리고 Shift = 정사각형·정원·45°. 거의 안 끈 것(4px 미만)은 버림. 지우개·되돌리기·병합은 보통 획과 같다.
  - 텍스트 부분 색(v2.10, 모든 화면): 텍스트 도구에서 글자 일부를 고르고 색을 누르면 그 부분만(`Text.runs`). 색 버튼은 pointerdown을 막아 선택을 지키고, 풀려도 4초 안의 마지막 선택을 쓴다. 글자를 고르지 않고 색을 누르면 예전처럼 선택한 칸 전체(이미 칠한 부분 색은 남음). 기록·썸네일·인쇄는 `drawTextBox`가 칸 폭 줄바꿈 뒤에도 글자별 색으로.
  - 이미지(v2.10): 도구바 끝 **이미지 도구**(편집기에만) — 슬라이드 위 이미지를 끌어서 옮기기 · 네 모서리로 크기(비율 유지, 맞은편 모서리 고정) · `×`·Delete 키로 삭제. 넣기 = 이미지 도구를 처음 누를 때(이미지가 없으면)·켜진 도구를 한 번 더 · 인스펙터 `이미지 [이미지 넣기]`(여러 장) · 붙여넣기(⌘/Ctrl+V) · 스테이지에 끌어다 놓기(놓은 곳에). 넣으면 선택된 채로 이미지 도구가 켜진다. 그리기는 lesson-view(`.img-layer`, 모든 scope·썸네일·갤러리 칸·인쇄).
- summary: whole 레코드 미니 캔버스 / individual 학생 수 표기 + 갤러리(읽기 전용).
- 저장: `cloudWriteRecord`(250ms 디바운스). 병합은 cloud.js `applyRecord`가 담당, ink는 `viewer.refresh()`.

**mcq**: 옵션 2~6. 정답 표시 = `reveal || phase==='ended' || 접속 학생 전원 응답`(전원 응답 시 교사 클라이언트가 `{phase:'ended', reveal:true, autoRevealed:true}`). 교사 화면 = `columnChart`(가로 색상 선지 타일 + 세로 막대, 막대/타일 탭 → `whoSheet` 응답자 목록). 학생: 질문 + 옵션 카드(`.choice`, 최소 56px, 1탭 선택, multiple이면 토글) + `[제출]`. 제출 후 pill '제출함', 마감 전 변경 가능. 채점 `correct = 집합 동일`, `score = correct?1:0`. reveal: 정답 옵션 `--highlight`, 내 선택 ✓/✗. 교사 스테이지: 질문 + `choiceBars`(옵션별 가로 막대, n·%), reveal 전 회색, 후 정답 `--accent`. activityBar(reveal, timer). validate: 정답 미선택 → '정답을 선택하세요'.

**poll (설문)**: 정답 없는 객관식 의견 조사. 편집기 = `questionEditor({ answers:false })` + `하나만·여러 개`. 응답 payload `{answerIds}`(객관식과 같음), score/correct null. 학생: 선택지 카드 + `[제출]`, 마감 전까지 바꿀 수 있음(결과 공개 중에도). 교사 `[결과 공개]`(activityBar `revealLabel`) → 학생에게 선택지별 인원·% 막대(내 선택 강조). 전원 응답 자동 공개 없음. 교사 스테이지 = `columnChart`(막대·타일 탭 → 응답자), 패널 = activityBar(결과 공개·타이머) + 학생별 고른 글자. 복습 화면은 공개 상태 그대로.

**short**: `long:true`면 textarea(maxLen 2000), 아니면 input(maxLen 300). 학생: 입력 + `[제출]` + 글자 수. activityBar(reveal = **`[답안 공개]`**, timer).
- 실시간 답안(v2.18): 학생 입력마다 `cloudWriteRecord(session, slide.id, "individual", 학생 id, { strokes:[], texts:[{ id:"sa-draft", draft, at:교사 시계 }], removed:[] })` — 250ms 디바운스(길어도 1초에 한 번). 학생 레코드 구독은 자기 칸만이라 교사에게만 실시간으로 간다(broadcast·responses처럼 반 전체로 퍼지지 않음). 같은 글은 다시 쓰지 않음, 마감 중에는 안 씀, 다시 들어오면 쓰던 글을 이어서(초기화 전·제출본과 같은 글 제외). 공개 중이면 학생 화면에 안내 `.sa-note`.
- 교사 스테이지: `liveItems` = 학번순(`rosterIds`) 학생마다 쓰는 글(제출본과 다르면 `draft` 작성 중 / `edit` 고치는 중) → 없으면 제출본(`done`). `activity.clearedAt`(activityBar [초기화]가 남기는 교사 시각)보다 앞선 글은 버림. 결과 가리기(v2.9)는 그대로 — 마감·답안 공개·타이머 끝 전에는 `응답 n · 작성 중 k`와 veil만, 도구 패널 명단은 `제출`/`작성 중`/`제출 · 고치는 중`. 레코드 변경은 `onSession`에서 `draftSig`(학생별 at)로 감지.
- 카드 탭 → 크게 보기(`ui.modal`, 열린 동안 실시간 갱신·쓰는 중이면 끝을 따라 스크롤, ◀ ▶·←/→ — 캡처 단계에서 막아 수업 화면의 슬라이드 넘기기와 겹치지 않음, `n / N`). 그 안 `[학생 화면에 함께 보기]` = 예전 카드 탭(강조 토글 `activity.pinned`, 제출한 학생만). reveal 시 학생은 pinned 제출본만(이름 없이), 누르면 크게. 수업 중 카드 글은 6줄까지(전체는 크게 보기).
- 기록 summary: 제출본(최신 순) + 제출하지 않고 쓰던 글 `미제출`. 복습의 `[정답 보기]`는 short만 `[답안 보기]`.

**blank**: 파싱 `/\[([^\]]+)\]/g`, 대안 `|`(첫 항목이 표시용). 줄바꿈 `<br>`. 입력칸 폭 `max(4, 최장 대안+1)ch`, 밑줄. 비교: trim, 연속 공백 1개, caseSensitive false면 소문자, 전각 숫자→반각. `score = 맞은 수/빈칸 수`, `correct = score===1`. reveal: 맞음 `--ok` 테두리, 틀림 `--danger` + 정답 `--highlight`. 교사: 빈칸별 정답률 막대 + 자주 틀린 답 상위 3. validate: 빈칸 0개 → '[정답]처럼 대괄호로 빈칸을 만드세요'.

**wordcloud**: 단어 trim, 최대 12자, 제출 내 중복 제거, 빈 단어 제외, 집계 키 = 영문 소문자/한글 그대로. 학생: 입력칸 maxWords개 + `[제출]` → 제출 직후 학생도 클라우드를 본다. 교사 스테이지 = 클라우드: 글자 크기 빈도에 따라 14→64px 선형, 상위 60개, 아르키메데스 나선 배치(AABB 충돌 검사), 색 4색 순환(`--ink`,`--accent`,`--ok`,`--warn`). 단어 탭 → 숨기기(`activity.hidden:[key]`). activityBar(timer:false, reveal:false).

**dragdrop (분류하기)**: buckets 2~4, items 2~12. **HTML5 drag API 금지** — pointer 이벤트 + `setPointerCapture` + `position:fixed` 고스트 + `elementFromPoint`로 버킷 판정, `touch-action:none`. 탭 대안: 아이템 탭(선택) → 버킷 탭(이동). 학생: 상단 트레이(섞어서) / 하단 버킷(≤768px 세로). 모두 배치해야 `[제출]` 활성. `score = 맞은 수/전체`, `correct = score===1`. reveal: 틀린 아이템 ✗ + 정답 버킷 라벨. 교사: 아이템별 정답률 막대. activityBar(reveal, timer).

**wall (담벼락)**: 글 = Response(itemKey `post_…`), payload `{text ≤200자, color 0..4, at, author?:'teacher'}`; 댓글 = Response(itemKey `cmt_…`), payload `{postKey, text ≤200자, at, author?}`. 교사도 `submit(…, {asTeacher:true})`로 글·댓글 작성(studentId=교사 id, 이름 '선생님' 배지). activity `{phase('ended'=잠금), pinned:[postKey], order:[postKey]}` — 표시 순서 = 고정 → order에 없는 새 글(최신 순) → order 순. 교사: 포인터 드래그로 위치 이동(마우스 6px, 터치 300ms 길게 누르기), ⋯ 메뉴(고정/해제·삭제), 모든 글·댓글 삭제, `[잠금]`. 학생: `[+ 글쓰기]` sheet, 내 글 수정/삭제, 댓글 작성/내 댓글 삭제. 팔레트 `#fff4c2 #fde2e4 #dbeafe #dcfce7 #ede9fe`. showNames false면 학생 화면에서 이름 숨김(교사 글은 항상 '선생님'). DOM은 itemKey 키로 보존, 순서 변경은 FLIP.

**link**: 전체 영역 iframe + 우상단 `[새 탭에서 열기]` 항상. iframe load가 3초 내 없거나 http(s) 아님 → 제목 + 큰 `[열기]` 버튼만. 프로토콜 없으면 `https://` 보정.

**embed**: 붙여넣은 html에서 첫 `<iframe>`의 src만 추출(`/<iframe[^>]*src=["']([^"']+)/i`), 아니면 입력 자체가 http(s) URL이면 그것을 src로. `javascript:` 거부. 렌더 `<iframe sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-presentation" allow="autoplay; fullscreen; clipboard-write" referrerpolicy="no-referrer-when-downgrade">`. 저장 시 `config.src`에 추출값.

**video**: YouTube(`parseYouTubeId`) → IFrame Player API(`loadYouTubeApi()` 1회 로드), 아니면 `<video controls playsinline>`(mp4/webm). 그 외 → 편집기 경고 '유튜브 또는 mp4 주소만 지원해요'. 재생 방식(v2.17) = `activity.playMode`(수업 중 교사 도구 패널) > `config.playMode`(편집기 [교사 재생 | 학생 재생]) > 기본 `'teacher'`. 교사 재생이면 학생 화면은 플레이어 없이 `칠판의 영상을 봐주세요`(바꾸면 학생 플레이어를 없애 재생도 멈춤), 학생 재생이면 학생도 각자 플레이어. `session.flow==='student'`(자유 이동·복습)면 늘 학생 재생. 교사 TeacherLive 는 늘 같은 플레이어.

**videoquiz**: `session.flow==='teacher'`면 교사 페이스 — 영상은 교사 화면에서만 재생, 학생은 `칠판의 영상을 봐주세요`; 시점 도달 시 교사 클라이언트가 일시정지 + `activity.vq={state:'question',qid}`·`vqAsked`, 학생 화면에 문제, `vqRevealed`(전원 응답 시 자동), `[계속 재생]`. `flow==='student'`면 아래 자율 재생. questions `[{id, atSec, kind:'mcq'|'short'|'essay', question, options?:[{id,text}]×4, answerIds?}]` atSec 오름차순. 250ms 폴링(YouTube `getCurrentTime`)/`timeupdate`. 미응답 문제 중 `atSec <= currentTime`이 있으면 일시정지 + 가장 이른 문제 오버레이(탐색으로 건너뛰어도 걸림). 제출 `submit(payload, { itemKey: q.id, correct })` → 닫고 재생. mcq 자동 채점, short(1줄 100자)/essay(여러 줄 1000자) 채점 없음. 교사 panel: 문제별 결과(mcq 막대, 서술 카드). 편집기: URL + 미리보기 플레이어 + `[현재 시점에 문제 추가]`(플레이어 현재 초 → atSec) + 문제 목록(시점 mm:ss 편집 가능).

**dino (공룡 점프)** — `js/slides/dino.js`
- config `{questions:[{id, question, options:[{id,text}]×4, answerIds:[id], sec}], jumpsPerQuestion:3}`, questions ≥1(validate). `sec` = 문제 제한 시간(v2.14, 10·15·20·30·45·60·90·120초, 기본 20초).
- 입력: 게임 영역 탭/클릭, Space, ArrowUp = 점프(pointerdown, 공중 점프 불가, `touch-action:none`).
- 시작: 교사 `[시작]` → 학생 3·2·1 카운트다운 후 `t0 = performance.now()`. running 중 늦게 들어온 학생도 즉시 플레이.
- 진행: 캔버스(논리 800×240, devicePixelRatio 대응, 폭에 맞춰 스케일). 선인장 1.1~2.0초 랜덤 간격, 기본 속도 320px/s, 문제 하나 풀 때마다 +6%. **장애물을 넘어 통과한 횟수**가 `jumpsPerQuestion`의 배수가 될 때마다 정지 + 문제 오버레이(제한 = 문제의 `sec`, 남은 초·막대, 다 되면 '시간 초과' = 오답). 답 → 정오 0.8초 표시 → 재개.
- **오답 미끄러짐(v2.14)**: 재개 0.25초 뒤(지나온 선인장이 비켜난 뒤, 땅에 있을 때) 세상이 멈춘 채 공룡이 0.35초 동안 뒤로 64px 미끄러지고(흙먼지) 0.5초 어질어질(별, 점프 불가) → 1.1초에 걸쳐 제자리로. 충돌 판정·통과 판정도 미끄러진 자리 기준.
- 충돌: 게임오버 아님. `hits += 1`, 0.8초 무적 + 깜빡임, 통과로 세지 않음.
- 종료: 마지막 문제 답 제출 시. `timeMs = performance.now() - t0`. `submit({correct,total,timeMs,hits}, {itemKey:'result', score:correct, correct: correct===total, timeMs})`.
- **목표 정답률·다시 풀기(v2.16)**: `passPct`(0·60·70·80·90·100, 기본 80) → 목표 정답 수 `need = ceil(Q × pct)`. Q문제를 다 푼 뒤 맞힌 문제 < need 면 계속 달리며 아직 못 맞힌 문제만 다시(선인장 jumpsPerQuestion 개마다, 화면 위 '정답 1/3 — 목표 3개! 틀린 2문제를 다시 풀어요'), 다시 푸는 중 목표에 닿으면 바로 끝. 안전장치 6회차. 다시 풀 문제가 있으면 틀려도 정답을 보여 주지 않는다.
- **틀렸을 때(`holdWrong`, 기본 켬)**: 그 문제 제한 시간이 끝날 때까지 문제 창이 남는다('시간이 끝나면 다시 달려요 · 이 문제는 다시 나올 수 있어요, 지금 찾아 두세요'). 시간 초과는 이미 시간이 지났으니 그대로 진행.
- **콤보**: 연속 정답 2·3·4개부터 달리기 속도 ×1.1·1.2·1.3(틀리면 끊김, 최대 기본의 2.2배). 선인장 간격은 거리 기준(빨라지면 다음 선인장·문제도 빨리 옴, 0.7초 아래로는 줄이지 않음). HUD `🔥 n콤보`, `정답 n/Q · 목표 m`.
- 순위: correct(**처음에** 맞힌 문제 수) 내림차순 → timeMs 오름차순 → hits 오름차순. 학생 종료 화면: `3위 / 24명` · 처음 정답 n/Q · 다시 풀어 n/Q · 시간 · 충돌. 결과 payload `{correct, solved, total, timeMs, hits, run, attempts, rounds, log}`.
- 리더보드 정답 칸(v2.14): 큰 `맞힌 수/Q` + 정답률 배지(푼 문제 중, 80% 이상 초록 · 50% 이상 주황 · 그 아래 빨강). 교사 화면(`is-big`)은 더 크게.
- broadcast `dino:progress {sid, answered(시도), tried, correct(처음 정답), solved, hits, round, last:[qi, opt, ok]}` 문제 답할 때마다 → 교사 리더보드 실시간('진행 중'·'다시 풀기 n회차' 행 포함). 다 못 풀고 끝나면 학생이 `submit({log, run, partial:true}, {itemKey:'log'})`.
- 그래픽: 픽셀 느낌의 단색 공룡/선인장(크롬 공룡 오마주, 캔버스 도형으로 직접 그림 — 외부 이미지 금지), 땅 선, 구름 약간.

**race (레이싱 퀴즈)** — `js/slides/race.js`
- config `{questions:[{id, question, options:[{id,text}]×4, answerId, sec}], laps:2}` (4지선다 고정, 정답 1개 교사 선택). questions ≥1.
- **조 편성**(교사 `[시작]` 시 1회): `ids = online ∩ participants`(없으면 participants), `groupStudents(ids, 4)` → `activity = { phase:'running', startedAt: Date.now()+3000 /*3초 카운트다운*/, groups:[{id:'g1', name:'1조', memberIds}] }`. n=0이면 toast('참여 학생이 없어요'). lane = memberIds 인덱스(0~3).
- **주행**: 입력 없음. 자동 주행, 기본 속도 = `1랩/12초`. 트랙 = 캔버스 둥근 직사각형(스타디움형) 오벌, 연석(빨강/흰색 줄무늬), 체크 무늬 결승선, 4개 레인. 차는 위에서 본 카트(색 4종: 초록·빨강·파랑·노랑) + 이름표.
- **퀴즈 체크포인트**: Q문항, k번째(1..Q) 문제는 진행도 `laps*k/(Q+1)`(랩 단위)에서 차가 정지하고 4지선다 오버레이(제한 = 문제마다 `q.sec` — v2.14. 편집기 문제 칸의 ⏱(10·15·20·30·45·60·90·120초, 기본 20초, 새 문제는 바로 앞 문제 값), 위 '문제 푸는 시간'을 누르면 모든 문제에 한 번에. sec 없는 옛 문제는 `config.quizSec`(v2.11) → 20초. 미응답=오답. 문제별 제한 배열을 시뮬레이션에 넘겨 모든 화면이 같은 값).
- **목표 정답률·추가 바퀴(v2.16)**: `passPct`(기본 80) → `need = ceil(Q × pct)`. 처음 Q문제를 다 푼 뒤 결승선에서 맞힌 문제 < need 면 **한 바퀴 더** — 그 바퀴에 아직 못 맞힌 문제만 고르게(`laps + r - 1 + j/(n+1)`), 결승선마다 다시 확인, 다시 푸는 바퀴 중 목표에 닿으면 남은 문제는 건너뜀. 안전장치 6바퀴. 체크포인트 차례 k(다시 풀기 포함)는 답의 정오만으로 정해지므로 모든 화면이 같게 계산. 다시 풀 문제가 있으면 틀려도 정답을 보여 주지 않는다. HUD `정답 n/Q · 목표 m` · `추가 n바퀴`, 결승선을 넘을 때 '한 바퀴 더' 알림.
- **틀렸을 때(`holdWrong`, 기본 켬)**: 그 문제 제한 시간이 끝날 때까지 체크포인트에 멈춤(mode `hold`, 차 위 빨간 ✕) → 그 뒤 미끄러짐. 멈춘 동안 학생 화면에 같은 문제(고른 답 표시, 정답 없음) + '지금 교과서·학습지에서 찾아 두세요'. 시뮬레이션 기준(2바퀴 5문제·목표 80%·제한 60초, 실제 simulate): 찍기(1.5초·25%) 839초, 대충(5초·50%) 310초, 고민(20~60초·90~95%) 138~292초 — 찾아보고 맞히는 쪽이 늘 빠르다(멈춤이 없으면 45~60초 고민이 찍기보다 느렸다).
- **콤보**: 연속 정답 2·3·4개부터 부스터 ×2.8·3.1·3.4, 부스터 뒤 다음 체크포인트까지 순항 ×1.15·1.3·1.45(window kind 'cruise'). 틀리면 끊김. 이름표 `🔥n`, 불꽃 입자, 콤보 소리.
- **정답** = 부스터: 3초 동안 속도 ×2.5(불꽃 효과). **오답** = 미끄러짐: 2.5초 동안 스핀하며 **뒤로 0.2랩 밀림**(점점 느려짐) → 멈춘 자리에서 4초 동안 ×0.5 (v2.14). 기준: 찍기(1.5초·정답 25%)가 성실하게 푸는 학생(6초·85%)보다 늦게 들어오게 — 2바퀴 5문제 평균 54초 vs 49초(v2.13 규칙에서는 39초 vs 48초로 찍기가 빨랐다). 랩 통과는 처음 넘은 한 번만 센다(뒤로 밀려 결승선 뒤로 갔다가 다시 넘어도 그대로).
- **효과음(v2.11, `js/slides/game-sound.js`)**: Web Audio로 합성(소리 파일 없음), 모두 작게. 학생 — 달리는 동안 배경음악, 카운트다운 삑·GO, 정답 부스터 쉭, 오답 타이어 끼익, 결승 팡파르(이 화면에서 달리다가 결승했을 때만). 교사 — 경주 중 배경음악(전원 완주하면 끔), 카운트다운, 학생이 결승할 때마다 짧은 소리. 공룡 점프도 같은 모듈(배경음악·점프·충돌·정답·오답·완주). HUD·머리 줄의 🔊 버튼 = 기기마다 음소거(`localStorage hada:gameSound`). 브라우저 정책상 첫 탭 뒤부터 소리가 난다(게임 화면이 붙어 있는 동안 첫 누르기에서 깨움), 탭이 숨겨지면 배경음악 멈춤.
- **결정적 시뮬레이션 + 이산 이벤트**(위치 스트림 금지): 각 클라이언트는 같은 규칙으로 모든 차를 시뮬레이션한다. 학생은 `race:answer {sid, gid, k /*체크포인트 차례*/, qi /*문제 번호*/, opt /*고른 선택지, -1 = 시간 초과*/, correct, at /* startedAt 기준 ms */}`(차례당 1회)와 `race:finish {sid, gid, lapMs:[…], totalMs, correct, solved, extra, total}`만 보낸다. 결과 payload 에 `log:[[qi, opt, ok], …]`, 다 못 달리고 끝나면 `itemKey:'log'` 응답. 수신자는 상대 차가 체크포인트 k에 도달하면 해당 answer 이벤트가 올 때까지 정지 상태로 그린다.
- **랩타임**: 랩 경계 통과 시 `lapMs.push(now - lapStart)`(문제 시간 포함). 결승(진행도 ≥ laps) → `submit({lapMs,totalMs,correct,total,gid}, {itemKey:'result', score:correct, timeMs:totalMs})` + `race:finish`.
- **학생 화면**: 자기 조 트랙만(최대 4대, 이름표, 랩 `1/2`, 지난 랩타임). 미배정(늦게 입장) → `다음 경기에 참여해요`. 결승 후 조 내 순위·랩타임 카드, 다른 차 계속 표시.
- **문제 리뷰(v2.16, 레이싱·공룡 공통 `common.gameReview`)**: 게임이 끝나면 교사 머리 줄 `[📝 문제 리뷰]` → 경기 화면·순위표 대신 한 문제씩 크게: 번호 칩(처음 정답률 색) · ◀ ▶ · 문제·그림 · 선택지별 '처음 고른 답' 막대(누르면 누가 골랐는지) · `처음에 맞힘 n/m · %`·`다시 풀어 맞힘`·`못 맞힘`·`시간 초과`. **정답은 기본으로 가려져 있고 문제마다 `[정답 보기]`를 눌러야** 정답 선택지에 ✓(나머지는 흐리게) — 문제별로 기억. ←/→ 키는 슬라이드 넘기기와 겹쳐 쓰지 않는다. 수업 기록(summary)에도 목록형 리뷰(같은 정답 보기). 답 기록 출처: 결과의 log → 'log' 응답 → 실시간 이벤트.
- **교사 TeacherLive**: 모든 조의 미니 트랙 그리드(조당 1칸). panel: `[조별 | 정답순]`. 조별 표(순위, 이름, **정답**, 합계, 랩1, 랩2 — 정답 칸은 큰 `맞힌 수/Q` + 정답률 배지, 주행 중이면 지금까지 푼 문제 기준), 조별 우승자 = totalMs 최소(🏆), 미완주 DNF. 정답순 = 모든 조 학생을 정답 수 → 정답률 → 기록 순(정답 수가 같으면 같은 순위, 🥇🥈🥉). 조 크게 보기 칩에도 `정답 n/Q`(정답률 색). 버튼 `[시작]` / `[종료]`(미완주 DNF 확정, phase ended) / `[다시]`(clearResponses, idle).
- 자동 종료: 배정 학생 전원이 완주하면 3초 후 교사 클라이언트가 phase ended.

---

## 7. 디자인 시스템 (styles.css, ui.js)

### 7.0 톤
종이 질감의 미니멀. 여백 넉넉, 선은 얇게, 그림자 약하게. 정보는 필요한 것만. 터치 타깃 ≥ 44px(학생 화면). 본문 15px(교사)/16px(학생). 로고만 붓글씨.

### 7.1 토큰 (`:root`)
```
--bg #f7f6f2  --surface #ffffff  --surface-2 #f1efe9  --line #e7e4dc  --line-strong #d6d2c8
--ink #1c1c22  --ink-2 #4a4a55  --muted #8b8a86
--accent #4f46e5  --accent-ink #3730a3  --accent-soft #eef0ff
--highlight #fde68a  --ok #15803d  --ok-soft #dcfce7  --warn #b45309  --warn-soft #fef3c7  --danger #b91c1c  --danger-soft #fee2e2
--radius 14px  --radius-sm 10px  --radius-lg 20px
--shadow-1 0 1px 2px rgba(20,20,30,.05), 0 2px 8px rgba(20,20,30,.04)
--shadow-2 0 12px 40px rgba(20,20,30,.12)
--font "Pretendard Variable", Pretendard, -apple-system, system-ui, sans-serif
--font-brush "Nanum Brush Script", serif   --ink-brush #1E293B   (랜딩/로고 기존 값 유지)
```
v1의 `#2b2a4a` 등 구 토큰은 제거(랜딩 인트로 관련 클래스 `.intro-*`, `.ink-word`, `.ink-highlight`, `.brand*`는 **그대로 유지**).

### 7.2 컴포넌트 클래스 (코어·플러그인 공용)
- 버튼: `.btn`(40px) `.btn-primary`(accent) `.btn-dark`(ink) `.btn-ghost` `.btn-danger` `.btn-sm`(32px) `.btn-lg`(48px) `.btn-icon`(정사각 40px) `.btn-block`. 학생 화면(`.stu`) 안의 `.btn` = 48px.
- 입력: `.field`(라벨 위 12px muted, 입력 44px, textarea), `.input`(단독), 포커스 링 `0 0 0 3px var(--accent-soft)`, `min-width:0; width:100%`.
- `.seg`(세그먼트 토글, 버튼 36px / 학생 44px, `.active`), `.pill`(24px) `.pill-live`(빨간 점) `.pill-ok` `.pill-warn` `.pill-muted`, `.dot`/`.dot.on`(온라인 점 8px).
- `.card`, `.list` + `.list-row`, `.empty`(한 줄, muted, 가운데), `.kbd`.
- `.choice`(옵션 카드: 56px+, 테두리, 왼쪽 원형 문자 A/B/C/D `.choice-key`, `.selected` `.correct` `.wrong`), `.bars` + `.bar-row`(라벨 | 막대 `.bar-fill` | 값), `.tile-grid`.
- `.toast`(하단 중앙, 2.5초), `.modal-back` + `.modal`(최대 560px, `.modal-wide` 920px), `.sheet`(하단 시트, 모바일/학생), `.drawer`(우측 패널 340px).
- 아이콘: `ui.icon(name)` → 24px stroke SVG span. 이름: `plus, trash, edit, play, stop, chevron-left, chevron-right, x, check, users, qr, copy, pen, highlight, eraser, text, undo, eye, eye-off, lock, unlock, refresh, timer, panel, maximize, grid, image, file, link, video, star, trophy, flag, more, logout, arrow-up, arrow-down, duplicate`.

### 7.3 레이아웃
- 교사 `.shell`: 사이드바 220px(로고, 탭: 수업 자료·수업 기록·학생·내 코드, 하단 이름·로그아웃) + `.main`(max-width 1200px, padding 28px). ≤768px: 사이드바 → 하단 탭바.
- 편집기 `.editor`: 상단 바(← · 제목 input · 저장 상태 pill · `[미리보기]` `[시작]`) + 본문 3열: 레일 196px | 스테이지 | 인스펙터 300px. ≤1024px 인스펙터는 스테이지 아래.
- 수업 진행 `.live`(전체 화면, 사이드바 없음): 상단 바 56px + 스테이지 + 접이식 `.drawer` 340px. 
- 학생 `.stu`: 상단 바 52px + 스테이지(남은 높이 전부, `min-height:0`) + 필요 시 하단 플로팅 도구바.
- 슬라이드 프레임 `.slide-frame`: 16:10 비율, **높이·너비 모두 컨테이너에 맞춤**(contain): `width: min(100%, calc((100dvh - <상단바>) * 1.6))`.
- `100vh` 대신 `100dvh`, `env(safe-area-inset-*)` 적용.

### 7.4 문구 규칙 (미니멀)
- 빈 상태는 한 줄: 자료 `아직 자료가 없어요`, 기록 `끝난 수업이 여기 모여요`, 참여자 `아직 아무도 없어요`.
- 삭제할 v1 문구: 랜딩 `인터랙티브 에듀테크`, `v0.1 draft · 로컬 동기화 데모`(랜딩 인트로·태그라인 `학생들과 필기를 공유하고, 소통하며 함께 수업합니다.`는 유지); 로그인 카드의 설명 문단 전부(교사 로그인은 버튼 아래 작은 `처음이면 자동으로 만들어져요`만); 학생 화면 `교사 흐름 — …`; 패널 설명문; 편집기 `수업 중에도 변경…`; 시작 모달 전체; 가져오기 안내 문단; 모드 버튼 desc.
- 라벨 표준: 모드 `발표·전체·개별·모둠`, flow `교사 진행·자유 이동`, 상태 `진행 중·끝남·중단`, 버튼 `시작·마감·정답 공개·초기화·종료·이어서·삭제`.

---

## 8. 라우트와 화면

| 라우트 | 소유 | 화면 |
|---|---|---|
| `/` | (기존) | 랜딩(인트로 유지). 버튼 `교사로 시작` `학생으로 참여` |
| `/teacher-login` | C | 카드: 이름·비밀번호·`입장` + 작은 `처음이면 자동으로 만들어져요` |
| `/student-login` | C | 늘 입력 폼이 위: 코드(1칸, 자동 대문자, 6자) · 학년/반/번호(`repeat(3,minmax(0,1fr))`, `type=text inputmode=numeric`) · 이름 · `입장`. 기억된 학생이 있으면(v2.10.1) `입장` 왼쪽에 점선 카드 `혹시 이 학생인가요? 5학년 1반 3번 김하나`(이름 크게) — 누르면 그 학생으로 입장(코드는 칸의 값 → 기억된 코드). 학년·반·번호를 그 학생과 다르게 치면 카드가 숨고 `입장`이 꽉 찬다. `?form=1`(대기 화면 `코드 바꾸기`)은 학생 정보를 채운 폼, 카드 없음 |
| `/student/join?c=CODE` | C | QR. 기억된 학생이 있어도 **바로 들어가지 않고** QR 코드를 채운 `/student-login` 폼(학년부터 입력, 기억된 학생은 `입장` 옆 카드로만 — 공용 태블릿에서 남의 이름으로 먼저 누르지 않게, v2.10.1) |
| `/r/:code` | C | 학습지 복습 QR(짧은 주소). `/student/join`과 같은 처리 — 코드 칸은 교사 코드·복습 코드를 모두 받는다 |
| `/student/review/:id` | C | 학생 페이스 복습(§9.4), 늘 첫 슬라이드부터. 진행 중인 수업이어도 머물고 위쪽 `[수업 들어가기]` |
| `/student` | C | 대기 카드: 맨 위 `👤 6-2-14 홍길동 | 로그아웃` · 교사 이름 · `선생님이 수업을 시작하면 자동으로 들어가요` · `코드 바꾸기` · 하단 작은 `내 기록` |
| `/student/live/:id` | C | 학생 수업 화면 |
| `/student/records` | C | 내 기록 목록 → 세션 상세(읽기 전용) |
| `/teacher` | B | 대시보드(탭: `lessons`(기본) · `records` · `students` · `code`). 쿼리 `?tab=` 지원. LIVE 세션 있으면 상단 배너 `진행 중 · 제목 [돌아가기]` |
| `/editor/:id` | B | 편집기 |
| `/live/:id` | B | 수업 진행(전체 화면) |
| `/teacher/session/:id` | B | 기록 상세 |

- 레거시 경로 `/teacher/live` → 진행 중 세션이 있으면 `/live/:id`, 없으면 `/teacher`.
- 제작자 워터마크(js/brand-banner.js, app.js에서 `initBrandBanner()`): 왼쪽 인스타 `sun_sunseng`, 오른쪽 `영욱T 제작` + `assets/print-mark.png`. 자리는 `--bb-h`(34px, ≤600px 30px) — `--sat = --sat0(기기 안전 영역) + --bb-h` 이고 모든 화면이 위쪽 여백에 `--sat`를 쓰므로 내용을 가리지 않는다(모달 뒤판은 `--sat0`, `.slide-frame` 폭 계산은 `--bb-h`를 뺀다, 모바일 sticky 상단 바는 `top: -bb-h`). 스크롤로 내용이 그 줄 아래로 지나가면 유리(반투명+blur)로 바뀌고 2.6초 뒤 위로 사라짐, 맨 위로 오면 제자리. 링크는 교사 전용 경로(`/teacher*` `/editor/` `/live/`)에서만 — `/`·학생 화면은 아이디 텍스트만. 인쇄 시 숨김.
- 라우트 등록은 app.js(C)가 한다. teacher.js(B)는 `teacherDashboard(params)`, `editorView({id})`, `liveView({id})`, `sessionDetailView({id})` 를 export하고 각각 **cleanup을 반환**.
- student.js(C)는 `studentWaitView()`, `studentLiveView({id})`, `studentRecordsView()` export.

---

## 9. 핵심 흐름

### 9.1 교사
- **로그인**: `cloudLoginTeacher` → whoTeacher → `cloudBootTeacher` → `/teacher`.
- **수업 자료 카드**: 썸네일(cover) · 제목 · `n장 · 날짜` · `[시작]`(primary) · `⋯` 메뉴(편집, 교과 옮기기, 복제(선택), 삭제). 카드 탭 = 편집기. 새 수업: `[+ 새 수업]` → 제목 promptDialog → 빈 ink 1장으로 생성 → 편집기. `[파일로 만들기]`(PDF·PowerPoint·이미지) → 파일 선택 → `fileToSlides` 진행률 → 생성 → 편집기.
- **교과(v2.15)**: 제목 아래 칩 막대 `[전체 n] [● 국어 n] … [○ 미분류 n] [+ 교과] [⚙ 관리]`. 전체 = 교과 순서대로 구역(교과 이름 누르면 그 교과만) + 마지막에 미분류, 교과 칩 = 그 교과 자료만. 고른 칩은 기기·교사마다 기억(`localStorage hada:subject:<교사 id>`), 수업 기록 탭과 함께 쓴다.
  새 수업·파일로 만들기 = 지금 고른 교과에(전체·미분류면 미분류). 옮기기 = 카드 ⋯ `교과 옮기기`(교과 목록 · 미분류 · + 새 교과) 또는 카드를 칩으로 끌어다 놓기, 편집기 제목 옆 `[● 교과 ▾]`. 교과를 바꿔도 자료 updated_at 은 그대로(순서 유지).
  `[⚙ 관리]` 창: 이름 바꾸기 · 색(누를 때마다 다음 색) · ▲▼ 순서 · 지우기(그 교과 자료는 미분류로, 자료·기록은 그대로). 같은 이름은 새로 만들지 않고 그 교과로. 교과가 하나도 없으면 막대 대신 안내 + `[+ 교과 만들기]`(기존 화면과 같음).
  수업 기록 탭: 교과가 있으면 같은 칩 막대(기록 수), 행마다 `● 교과` 표시 — 기록은 그 수업 자료의 지금 교과를 따른다.
  006 마이그레이션 전 DB(subjects 테이블·lessons.subject_id 없음): `subjectsReady()` false → 교과 UI 모두 숨김, 예전처럼 한 목록.
- **편집기**: 열 때 `lesson.slides===null`이면 `cloudFetchLessonSlides`(진행률 pill). 레일: 썸네일(`def.thumb`), 탭=선택, 길게 누르기/`⋯`=복제·삭제·위/아래(드래그 정렬은 pointer 이벤트로, HTML5 DnD 금지). 레일 하단 `[+ 슬라이드]` → 모달 그리드(카테고리 섹션, 아이콘+라벨, 탭 즉시 현재 뒤에 삽입) · `[+ 파일]`(PDF/이미지 → ink 여러 장). 스테이지 = `mountSlideHost({role:'editor'})`. 인스펙터 = 제목 input + `def.Editor().inspector`(있으면) + validate 경고. 변경 → 300ms 디바운스 `cloudSaveLesson` + 상단 pill `저장됨/저장 중…/저장 실패 [다시]`.
- **시작**: `수업 이름` 입력 창(기본값 = 같은 자료의 직전 수업 이름 또는 자료 제목, 예: '임진왜란 3학년 2반') → `cloudStartSession({lesson, teacher, title})` await → 성공 `/live/:id`, 실패 toast. flow 기본 teacher. 기록 화면에서 이름 바꾸기(patchSession title).
- **상단 바 세 구역(v2.9)**: 왼쪽(`←` · 제목 · 저장 중 · 코드) | 가운데(`◀ n/N ▶`) | 오른쪽(모드 seg · 모둠 · 진행 방식 · 종료). 넓은 화면(>1100px)은 `grid 1fr auto 1fr`로 가운데가 늘 가운데 → 모드 seg가 생기고 없어져도 ◀ ▶ 자리가 그대로(연속 클릭이 빗나가지 않게). 좁은 화면은 모드·모둠 자리를 보이지 않게 비워 둔 채(`.is-off` = visibility hidden) 같은 효과. 진행 방식 이름은 ≤1280px에서 아이콘만.
- **수업 진행 `/live/:id`** (v2.7 정리 — 한 기능은 한 자리): 상단 바는 수업 흐름만 — `←`(대시보드, 수업은 계속) · 제목 · **코드 pill `ABC123`**(탭 → QR 모달: 큰 코드 + QR + URL 복사 + 아래 줄 `복습 코드 XYZ789 [복습 QR] [빈 학습지]`) · `◀ 3/12 ▶`(가운데 숫자 탭 → 썸네일 스트립 팝오버로 점프) · (ink일 때만) 모드 seg `발표·전체·개별·모둠` · (모둠 모드일 때만) `[👥 2모둠 · 미배정 n]`(= ink `actions.groups()` 모둠 편성 창, 모둠이 없을 때 모둠으로 바꾸면 창이 바로 뜸) · flow 토글(`교사 진행`/`자유 이동`) · `[종료]`. 학습지 화면에서는 모드 seg·모둠 버튼을 숨기고, ◀ ▶·스트립을 누르면 슬라이드 화면으로 돌아간다.
  - 본문 = 스테이지 | 패널(한 번에 하나) | **오른쪽 아이콘 레일**(64px, 이름표 달린 칸): `📝 학습지`(있을 때만, 배지 = 지금 쓰는 학생 수, 고정 중이면 자물쇠) · `참여`(배지 = 접속 수 → 패널: 참가자 목록 — 온라인 점, 이름, 미제출(응답형), 모둠) · `추가`(레일 왼쪽 작은 창: 지금 슬라이드 다음에 끼워 넣을 8종) · `도구`(그 슬라이드 플러그인의 `panel`이 있을 때만 — 마감·정답 공개·타이머·응답자 등. 패널 제목 `도구 · 객관식`). 같은 칸을 다시 누르거나 ×·Esc → 닫힘. 넓은 화면(진입 시 ≥1100px)은 도구가 있는 슬라이드로 오면 도구를 저절로 펼치고(교사가 직접 닫으면 다시 열 때까지 멈춤), 도구가 없는 슬라이드(필기 등)에서는 닫혀 스테이지가 넓다. ≤1024px에서 패널은 레일 옆에 겹쳐 뜬다. 필기 슬라이드(ink)는 panel이 없다(모드는 상단 바에만).
  - **아래 좌우 넘기기**(`.lt-edge`, 상단 ◀ ▶와 같은 `step(±1)`, 학습지 화면에서는 숨김): `›` = 레일 맨 아래(`.lt-edge-rail`, `margin-top:auto`, 48px — 레일은 늘 있는 자리라 슬라이드 종류와 상관없음). `‹` = `.live-body`의 절대 위치 자식(스테이지 레이아웃 밖이라 슬라이드 크기·비율이 그대로) — 필기 슬라이드가 한 장 크게 보일 때(`.ink-stage.zoom-view > .slide-frame`)만. 막을 영역 = 프레임 ∩ 보기 영역(확대 시 보기 전체) + 스테이지 안 `.ink-float`·`.ink-toolbar`, 좁은 화면에서 겹쳐 뜬 패널은 그 왼쪽까지. 크기는 `›`(48px) → 40 → 36px, 자리는 `›`와 같은 높이 → 왼쪽 아래 모서리에서 위로(스테이지 아래 60% 안) → 맨 아래 줄을 따라 안쪽으로(가운데 넘지 않음). 없으면 숨김. 기기 안전 영역은 `.lt-safe-probe`(padding = `--sal`·`--sab`)로 잰다. 다시 놓기: ResizeObserver(스테이지·본문)·MutationObserver(필기일 때만 스테이지 style/class/hidden)는 그리기 전에 바로, `syncTop`·`syncDrawer`는 rAF.
  - **슬라이드 크게(v2.18)**: 필기 슬라이드일 때 `.live-stage` 여백 24 → 8px(`:has(> .slide-host[data-type="ink"])`, 맞춤 여백 10px은 zoom-view). ink 교사 도구바 자리는 ink.js `TeacherLive.placeBar` 참고.
  - **상호작용 추가**(맨 앞 `[빈 슬라이드]` = 흰 필기 슬라이드(모드 전체)를 창 없이 바로 끼워 넣고 이동, 0.7초 연타 방지 · 정답 없는 상호작용·미디어: 담벼락·주관식 서술형·워드클라우드·설문·웹 링크·임베드·동영상): 타입 탭 → 그 타입의 `Editor`를 창에 띄워 내용 입력 → `[추가하고 이동]`(validate 경고면 toast 후 창 유지) → `cloudInsertSessionSlide`로 현재 슬라이드 **다음**에 끼워 넣고 바로 그 슬라이드로(진행 중 게임이면 이동과 같은 확인). 이 수업에만 들어가고 수업 자료에는 저장하지 않는다. 학생은 자유 이동 중이어도 새 슬라이드로 옮겨진다(새로 생긴 id 기준).
  - **학생 순서(v2.13)**: 참여 패널·필기 개별 갤러리·학습지 갤러리·모둠 편성 칩은 **접속 중인 학생을 위에 번호순(학년·반·번호·이름), 그 아래 접속하지 않은 학생 번호순**(참여 패널은 사이에 `접속 안 함 n` 구분선). 예: 12번을 '김땡땡'으로 잘못 넣고 '박땡땡'으로 다시 들어오면 박땡땡은 위, 김땡땡은 아래. 순서는 `ch.recent()`(끊긴 뒤 10초 유예)로 정하고 점(●)은 `online()` 그대로 — 태블릿이 잠깐 잠들어도 칸이 오르내리지 않는다. 갤러리는 순서가 바뀔 때만 칸을 옮기고(칸·그림·보이는 영역 재사용, 다시 그리지 않음) 아니면 점만 바꾼다. 이름을 아직 모르는 학생은 각 묶음의 뒤.
  - 키보드: ←/→ 이동(학습지 화면이면 학습지 쪽), F 전체화면, Esc = 팝오버 → 학습지 화면 → 패널 순으로 닫기.
  - 이동/모드/flow = `patchSession`. 이 화면은 store 구독 → host.update만 호출(재마운트 금지). 1초 interval 금지.
  - `[종료]` → confirmDialog → `cloudEndSession(session,'completed')` → `/teacher/session/:id`.
- **기록 `/teacher/session/:id`**: `cloudFetchSession` → 요약(날짜·참여 n명·슬라이드 n장) + seg `슬라이드별 / 학생별`. 슬라이드별 = 각 슬라이드 `def.summary`. 학생별 = 학생 선택 → 그 학생 ink(읽기 전용) + 응답(정오) 슬라이드 순. `[인쇄]`(슬라이드별 = 화면 그대로, 학생별 = 그 학생 학습지 인쇄) · `[학생 인쇄]`(js/print.js: 1) 슬라이드 선택 2) 학생 선택 → 학생마다 A4 세로, @page 여백 0 + 시트 안 패딩 5mm(프린터가 찍을 수 있는 안쪽), 머리글 작게, 오른쪽 위 워터마크 `assets/print-mark.png`. 필기 슬라이드는 16:10 틀에서 학습지 이미지 영역만 잘라 JPEG로 렌더 — 세로 학습지는 PDF 자체의 흰 여백도 잘라(zoom-view `pageRectFor` 내용 영역 ∪ 필기 범위) 종이 폭을 꽉 채움, 가로 슬라이드는 한 장에 2개). 기록 화면 그대로 인쇄도 @page 여백 5mm. `[이어서]`(stopped/completed → `cloudResumeSession` → `/live/:id`) · `[삭제]`.
- **기록 탭**: 세션 목록(제목, 날짜, 참여 n, 상태 pill). 진행 중 세션은 맨 위 `[돌아가기]`.
- **학생 탭**: 이 교사 세션에 참여한 학생 표(학번순) → 행 탭 → 참여 세션 목록.
- **내 코드 탭**: 큰 코드 · QR · `[코드 복사]` `[링크 복사]`.
- **복습 링크 바로 복사(v2.8)**: 기록 탭 목록의 행마다 `[🔗 복습 링크]`(좁은 화면은 아이콘만), 기록 상세 메타 줄 `[🔗 복습 링크 복사]`, 수업 진행 코드 창 복습 줄 `[링크 복사]` — 누르면 `/r/CODE` 주소를 바로 복사(결석생·다시 공부할 학생에게 붙여넣기). 목록은 이미 있는 복습 코드를 `cloudFetchReviewCodes`로 한 번에 미리 읽어 누른 자리에서 복사하고, 코드가 없으면 만들면서 복사(`copyTextLater` — ClipboardItem Promise). 복사하지 못하면 복습 코드 창(코드·QR·주소)을 띄운다.
- **복습 코드**(기록 상세 메타 줄 `[▦ 복습 XYZ789]` → 모달: 큰 코드 + QR(`/r/CODE`) + `[링크 복사]` `[빈 학습지 인쇄]`). 기록 상세 버튼 `[빈 학습지]` = 필기 슬라이드 고르기 → 기본 필기만 인쇄(머리글에 `학년 반 번 이름` 칸). `학생 인쇄`·`빈 학습지` 모두 **장마다 머리글 오른쪽 위**(워터마크 옆)에 `복습 코드 XYZ789 · 주소` + QR 12mm(머리글 13mm).

### 9.2 학생
- **입장**: 코드 정규화 → `cloudFindTeacherByCode`(없으면 '코드를 확인해 주세요') → `cloudJoinStudent`(서버 id 채택, studentProfile 저장 + lastCode) → `cloudFetchLiveSession(teacherId)` → 있으면 `cloudAddParticipant` → `/student/live/:id`; 없으면 `/student`(대기, `watchTeacherLive`로 자동 입장).
- **수업 화면 `/student/live/:id`**: store에 없으면 `cloudFetchSession(id, {forStudentId})`. `subscribeSession` + `joinSessionChannel`(presence) + `send('session:hello')`. 상단 바: 로고(작게) · 제목 · 모드 pill(ink일 때만, `전체`/`개별`/`모둠 · 2모둠`) · `3 / 12`(자유 이동이면 `◀ ▶`) · `나가기` · `👤 홍길동 | 로그아웃`(≤720px 이름만·≤420px 아이콘만). 스테이지 = `mountSlideHost({role:'student'})`.
  - flow teacher: currentSlide를 따른다. flow student: 로컬 인덱스(처음엔 currentSlide).
  - 세션 status가 live가 아니게 되면 `수업이 끝났어요` 2초 → `/student-login`(입력 폼 + `혹시 이 학생인가요?` 카드, v2.10). 대기 화면은 다음 수업에 자동 입장하므로, 다음 시간 다른 반이 같은 태블릿을 쓰면 앞 학생 이름으로 들어가 버리기 때문. 같은 학생은 카드 한 번.
  - `나가기` → 채널 leave → `/student`.
- **로그아웃**(v2.10): 대기·수업·복습·내 기록 화면의 `이름 | 로그아웃` 버튼(수업 중에만 한 번 확인). studentProfile·whoStudent를 지우고 `/student-login` 폼으로 — 코드는 이 탭(sessionStorage `hada:joinCode`)에 남겨 다음 학생은 학년·반·번호·이름만 입력.
- **내 기록**: `cloudListSessionsForStudent` → 세션 → 읽기 전용 학생별 뷰(교사 기록의 학생별 컴포넌트와 같은 구조를 student.js가 간단히 구현: 슬라이드마다 ink 읽기 전용 / `def.summary`에 내 응답만 넘김). 상세 위 `[복습하기]`(진행 중이면 `[수업 들어가기]`).

### 9.4 복습 코드 (학습지 QR, v2.5)
- 수업(세션)마다 6자리 `review_code`(교사 코드와 같은 문자, 겹치지 않게). `cloudStartSession` 직후 백그라운드로 만들고, 없던 세션은 기록·인쇄·코드 창을 열 때 만든다. 한 번 정해지면 바뀌지 않는다.
- 학생: QR `/r/CODE` 또는 로그인 코드 칸에 입력 → 교사 코드 먼저 조회, 없으면 복습 코드 → 학생 등록 → 늘 `/student/review/:id`(v2.8: 진행 중인 수업이어도 학생 페이스 복습 — 화면 위 `[수업 들어가기]`로 수업에 참여). lastCode(대기 화면용 교사 코드)는 이전 값을 유지하고 없을 때만 그 수업 교사 코드로.
- 복습 화면: 상단 바 제목 · `복습` pill · (수업에서 정답을 공개한 mcq·blank·dragdrop·short만) `[정답 보기]↔[다시 풀기]` · `◀ n/N ▶` · (진행 중인 수업이면) `[수업 들어가기]` · `나가기`(→ 내 기록). 복습은 들어올 때마다 **첫 슬라이드부터**(v2.8), 같은 탭에서 새로고침했을 때만 보던 곳 이어서(sessionStorage `hada:review:<세션>:<학생>`). 실시간 구독 없음, 참여자 등록은 함(수업에 없던 학생도 교사 기록에 보임).
- 보기(`sessionView` Proxy): flow `student`, ink는 모두 `mode:'individual'`(내 칸에 저장) + 수업 때 전체·모둠 칠판 필기를 바닥 그림으로 합친 슬라이드(removed 반영, 스냅샷 불변). 응답형은 `phase:'idle', reveal:false, autoRevealed:true`(혼자라 '전원 응답 자동 공개' 끔) → 이전 답이 채워진 채로 다시 제출(같은 행 upsert, 교사 기록에도 반영). `[정답 보기]` = `phase:'ended', reveal:true`. 게임(dino·race)은 `phase:'ended'`(결과만).
- **미리보기 띠(v2.12)**: 상단 바 바로 아래 `.rv-strip` — 캔바·PPT처럼 번호 붙은 16:10 작은 그림(`def.thumb`), 지금 슬라이드 강조(`.rail-item.active`)·누르면 이동, 학습지 쪽은 `📝 학습지` 구분선 뒤(번호는 `n/N`과 같은 전체 번호). 그림은 띠에 보일 때만 그리고(IntersectionObserver, 좌우 320px 앞당김) 필기·학습지는 내 개별 칸 필기까지 얹는다(removed 반영). 떠난 슬라이드 칸은 다시 그려 방금 쓴 필기가 보인다. 지금 칸이 띠 밖이면 가운데로 스크롤(보이면 그대로), 마우스 세로 휠 = 가로 이동. `n/N ▾` 버튼으로 접고 펴며 기기마다 기억(localStorage `hada:reviewStrip`), 기본은 화면 높이 560px 이상이면 펼침(가로 휴대폰은 접힘). 띠를 접어도 스테이지가 줄 3을 지키게 `grid-row`를 정해 둔다.
- **학습지 바로 가기(v2.12)**: 학습지가 있으면 오른쪽 가장자리 📝 탭(수업 화면과 같은 `wsTab`) — 슬라이드에서 누르면 마지막으로 본 학습지 쪽(처음이면 1쪽)으로, 학습지에서 누르면('슬라이드') 마지막으로 본 슬라이드로. 앞뒤 슬라이드·학습지 배경은 미리 받는다(`wsPrefetch`). 학생 식별은 학년·반·번호·이름이 같으면 같은 학생 행(`cloudJoinStudent` upsert onConflict) → 수업 때 쓴 학습지가 그대로 보인다.
- **복습 화면 쏠림(v2.12에서 고침)**: 원인 = `prefers-reduced-motion: reduce`(윈도우 '애니메이션 효과' 끔·태블릿 '애니메이션 제거')의 `* { transition-duration:.01ms }` — 기본 `transition-property: all`이라 모든 스타일 변경이 아주 짧은 전환이 되어, 넘길 때 도구바를 아래 → 왼쪽 세로로 옮긴 직후 `getBoundingClientRect()`가 옛(가운데) 자리를 돌려줌 → 왼쪽 여백 ≈ 화면 절반으로 맞춰 슬라이드가 한쪽으로 쏠리고 잘림. 넘친 도구바가 만든 스크롤 막대의 크기 변화로 가끔 저절로 돌아왔고, 계속 넘기면 그대로 남았다. 고침: 동작 줄이기에서는 `transition: none`(transitionend 쓰는 코드 없음) + ink `placeBar()`가 자리를 바꾼 다음 프레임에 한 번 더 재고 여백을 도구바 최대 폭(왼쪽 200px·아래 160px)으로 자름 + 필기 스테이지·학습지 스테이지 `overflow:hidden`(스크롤 막대가 생겼다 사라지며 다시 맞춤을 부르지 않게).

### 9.5 학습지 (v2.6)
- **무엇**: 수업 자료에 미리 올려 둔 PDF·이미지 쪽(`lesson.worksheet`, DB `worksheet_pages`). 슬라이드 진행과 별개로 학생이 수업 중 언제든 열어 **각자** 필기한다. 쪽은 ink 슬라이드 모양(`mode:'individual'`), 필기는 기존 `slide_records`(slide_id = 쪽 id, scope individual)에 저장 → 실시간·병합·기록·인쇄가 그대로 동작.
- **편집기**: 상단 `[📝 학습지 n]` → 창: 쪽 썸네일 격자(앞으로·뒤로·삭제) + `[PDF·이미지 추가]`(여러 파일, `fileToSlides` → mode individual). 변경은 slides와 같은 300ms 디바운스 `cloudSaveLesson`(④ worksheet_pages 삭제→upsert, `lesson.worksheet===null`이면 건드리지 않음). 복제 시 함께 복사.
- **세션**: 시작 때 `session.worksheet` 스냅샷(`session_snapshots.worksheet`, 불변). `cloudFetchSession`은 `slides,worksheet`를 읽고 열이 없는 DB면 `slides`만(`snapHasWs`). 수업 중 슬라이드 끼워 넣기는 `slides`만 upsert하므로 학습지는 보존.
- **교사 `/live/:id`**: 학습지가 있으면 오른쪽 레일에 **📝 학습지**(배지 = 지금 쓰는 학생 수, 5초마다 다시 셈, 고정 중이면 자물쇠). 누르면 슬라이드 호스트는 숨긴 채(상태 유지) 스테이지를 **학습지 화면**으로(열려 있던 도구 패널은 접고, 닫으면 다시 펼침): 머리 줄 `📝 학습지 · [1][2][3](쪽 버튼, 쪽마다 작성 중 배지; 13쪽 이상은 ◀ n/N ▶) · 작성 중 n · 작성함 m/전체 · 학생 화면 고정 (스위치)` + 본문 = `mountSlideHost({ role:'teacher', sessionView: makeWsSessionView() })` → ink `TeacherLive` **개별 갤러리** 재사용(필기 부분/전체 보기, 칸 탭 → 크게 보기·첨삭). 열려 있을 때 ←/→는 학습지 쪽. 닫기 = 레일 📝 다시 누르기 · Esc · 상단 ◀ ▶.
- **띄우기(강제 배정) = '학생 화면 고정' 스위치**: `activity.__ws = { force:boolean, at }`(`__snap`처럼 예약 키, `patchSession`으로 broadcast+DB). 켜면 모든 학생 화면이 학습지로 바뀌고 닫기 버튼이 잠긴다(쪽 이동은 자유). 끄면 학생 화면은 열린 채 남고 탭으로 닫을 수 있다.
- **학생 `/student/live/:id`**: 학습지가 있으면 오른쪽 가장자리 📝 탭. 탭 → 슬라이드 스테이지 숨김(호스트 유지, 비디오 등 상태 보존) + 학습지 스테이지(머리 줄 `📝 학습지 · ◀ n/N ▶`, 본문 = ink `Student` 개별 모드: 도구바·확대). 탭을 다시 누르면 닫고 슬라이드로. 띄워진 동안은 탭이 잠금 표시(누르면 toast). `activity.__ws.force`가 켜지는 순간 자동으로 열리고 toast. 쪽 기억 `sessionStorage hada:ws:<세션>`. ←/→는 학습지가 열려 있으면 쪽 이동.
- **'작성 중'/'작성함'**(`wsStats`): 학생마다 모든 쪽의 자기 획·글자(by = 학생, 지운 것 제외) 중 가장 늦은 ts. 20초 안이면 작성 중, 하나라도 있으면 작성함. 서버 왕복 없이 records만으로 계산(broadcast 없음).
- **기록·복습·인쇄**: 기록 상세(슬라이드별·학생별)와 학생 '내 기록'은 슬라이드 뒤에 `학습지 n` 섹션을 이어 붙인다(태그 pill '학습지'). 복습 화면도 뒤에 이어서(내 개별 칸에 계속 필기, v2.12 미리보기 띠·📝 탭 — §9.4). 학생 인쇄·빈 학습지 인쇄의 선택 격자에 학습지 쪽이 '학습지 · n쪽'으로 함께 나온다.
- **기록 크게 보기(v2.13)**: 기록의 학습지 쪽(학습지 보기)·필기 칸(학생별)·학생 칸과 전체 칠판(슬라이드별 ink `summary`)을 누르면(또는 Enter) ink `openInkViewer` 팝업 — 읽기 전용 확대 보기(두 손가락·Ctrl+휠·`[− 100% +]` 확대, 끌기·휠 이동, 100% = 맞춤 ↔ 폭 맞춤). 맞춤 대상 = 학습지 내용 영역 ∪ 그 칸의 필기 범위(`zoomInclude` → zoom-view `include`, 종이 안으로) — 빈 칸에 쓴 답도 처음부터 보인다. 학습지·학생별은 그 학생의 쪽들을, 슬라이드별은 그 슬라이드의 칸들을 `◀ n/N ▶`·←/→로 넘긴다(창 안 키만, 뒤 화면 학생 전환과 겹치지 않음). 넘길 때 이전 보기는 정리(캔버스 1개).
- **기록 상세 '학습지' 보기(v2.12)**: 학습지가 있는 수업이면 `[슬라이드별 | 학생별 | 학습지]`. 학습지 = 학생 칩(숫자 = 그 학생이 직접 쓴 쪽 수, `wsLastTs` — 교사 첨삭 제외, 안 쓴 학생은 흐리게) + `◀ 이름 · 학습지 N쪽 중 n쪽 작성 ▶`(←/→도 다음 학생) + 쪽마다 큰 그림: 16:10 틀을 `renderSlide`(개별·읽기 전용)로 그리고 `pageRectFor`의 종이 영역만 보이게 잘라(`.t-wsp` 종이 비율, 안쪽 폭 100/pw%·left −x0/pw·top −y0/ph) 세로 학습지가 꽉 차게. 안 쓴 쪽은 '· 빈 쪽'. `[인쇄]`는 그 학생 학습지만(`printStudents` slideIds = 학습지 쪽).
- **005 전 DB**: `worksheet_pages`가 없으면 `wsTableMissing` → 학습지 조회·저장을 건너뛰고 편집기 창은 '학습지를 불러오지 못했어요'. `session_snapshots.worksheet`가 없으면 세션 시작·조회가 `slides`만으로 동작.

### 9.6 팝업 상호작용 (v2.9, js/popup.js)
- **무엇**: 필기 슬라이드의 한 곳(핀)에 상호작용을 붙여 두고, 수업 중 교사가 핀을 누르면 교사·학생 화면에 그 상호작용이 팝업으로 떠서 바로 진행한다(닫으면 슬라이드로).
- **데이터**: `ink slide.config.hotspots = [{ id:'pop_…', x, y, type, title, config }]`(x,y = 16:10 프레임 비율, 핀 가운데). 팝업 = 가상 슬라이드 `{ id: 핀 id, type, title, config, _parent }`(`popSlideFor`) → 응답 `responses[핀 id]`·활동 `activity[핀 id]`라 마감·공개·기록·복습이 일반 슬라이드와 같다. 넣을 수 있는 타입 `POP_TYPES` = 객관식·주관식·설문·빈칸·워드클라우드·분류·담벼락·웹 링크·임베드·동영상. 편집기 슬라이드 복제는 핀 id를 새로(`freshHotspotIds`).
- **편집기**: 도구바 `[+ 팝업]` · 인스펙터 '팝업 상호작용'(목록 · 고치기 · 빼기 · `[+ 팝업 상호작용 넣기]`) → 종류 고르기 → 그 타입 편집기 창 → `[넣기]`. 슬라이드 위 핀은 끌어 옮기고(놓을 때 저장), 누르면 고치기 창(빼기·저장).
- **핀**: 프레임 안 레이어(z-index 2 — 필기 캔버스 위, 핀 밖은 pointer-events 없음)에 40px 원 + 타입 아이콘(이름은 마우스를 올리면). 교사 화면(발표·전체)은 은은한 파동, 열린 핀은 진한 색. 개별·모둠 갤러리에서는 머리 줄 버튼(`hotspotChips`).
- **세션**: `activity.__pop = { id, at } | null` — 교사가 핀을 누르면 열고 다시 누르기·×·Esc·다른 슬라이드로 이동하면 닫는다(`setPop`, patchSession). 교사 화면은 스테이지 위 팝업(오른쪽에 그 활동의 도구 패널 — 마감·정답 공개·타이머), 학생 화면은 전체 팝업 '선생님이 띄웠어요'(닫기 없음 — 선생님이 닫으면 닫힘). 결과 가리기(§6.3)도 그대로.
- **자유 이동·복습**: flow 'student'(자유 이동·복습 화면)이면 학생 화면에도 핀이 보이고 눌러서 자기 화면에서만 연다(닫기 가능, 슬라이드를 넘기면 닫힘). 교사 진행이면 학생 화면에 핀을 그리지 않는다.
- **기록**: 기록 상세(슬라이드별·학생별)와 학생 '내 기록'에 그 슬라이드 바로 뒤에 '팝업' 표지로 이어 붙인다.

### 9.3 실시간 규칙 요약
- 교사 변경 → broadcast 선반영(즉시) + DB 디바운스 확정. 수신은 rev 비교.
- 필기: slide_records 증분(250ms 디바운스, 병합). broadcast 미사용.
- 응답: responses upsert → postgres_changes(필터 session_id) → host가 `onResponses`.
- 게임: broadcast 이산 이벤트만.
- 재연결: SUBSCRIBED 재진입·visibilitychange·online → 그 세션만 resync.

---

## 10. 수용 기준 (리드가 브라우저로 검증)
1. 교사 로그인 → 새 수업(PDF 3장) → 편집기에 썸네일·이미지 표시, 새로고침 후에도 유지. 삭제 후 새로고침해도 삭제 유지.
2. `시작` → `/live/:id` 1초 내. 다른 탭에서 학생 로그인(코드) → 2초 내 교사 화면 `● 1`, 학생 화면에 슬라이드.
3. 교사 ▶ → 학생 화면 0.5초 내 이동. 모드 `개별` → 학생 도구바 표시, 학생 필기 → 교사 갤러리 2초 내 반영.
4. 각 타입 슬라이드: 편집 → 진행 → 학생 응답 → 교사 결과 갱신 → 정답 공개.
5. 공룡: 시작 → 학생 플레이(탭 점프) → 문제 → 결과 → 교사 리더보드. 레이싱: 학생 3명 이상 → 조 편성 → 레이스 → 랩타임 → 교사 조별 결과·우승자.
6. 학생 로그인 카드가 320px~1440px에서 넘치지 않음. 콘솔 에러 0.
