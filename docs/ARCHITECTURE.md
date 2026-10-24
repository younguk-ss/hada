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
- 세션 = 수업 1회. 수업 자료(lesson)의 슬라이드 **스냅샷(시작 후 불변)** 을 가진다. 슬라이드는 여러 **타입**(필기·퀴즈·미디어·게임).
- 필기(ink) 슬라이드는 모드 `none(발표)`/`whole(전체)`/`individual(개별)`/`group(모둠)`를 가지며 교사가 수업 중 1탭으로 전환한다.
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
lesson   = { id, teacherId, title, createdAt, updatedAt, slideCount, cover /*첫 슬라이드 썸네일 URL|null*/,
             slides: Slide[] | null /* null = 아직 안 불러옴 */ }
Slide    = { id, type /*'ink'|'mcq'|…*/, title /*string|null*/, config /*object, 타입별*/,
             // ink 전용(다른 타입은 생략 가능):
             bg /*URL|null*/, bgPath /*storage path|null*/, thumb /*URL|null*/, mode /*'none'|'whole'|'individual'|'group'*/,
             strokes /*Stroke[] 편집기 기본 필기*/, texts /*Text[]*/ }
session  = { id, lessonId, teacherId, title, status /*'live'|'stopped'|'completed'*/, flow /*'teacher'|'student'*/,
             currentSlide /*int*/, rev /*number, 단조 증가*/, groups: [{ id, name, memberIds: [] }],
             activity: { [slideId]: ActivityState }, startedAt, endedAt,
             participants: studentId[], slidesSnapshot: Slide[],
             records: { __whole: { [slideId]: Rec }, __groups: { [groupId]: { [slideId]: Rec } }, [studentId]: { [slideId]: Rec } },
             responses: { [slideId]: Response[] } }
Rec      = { strokes: Stroke[], texts: Text[], removed: string[] /* 지운 stroke id (whole/group 병합용 tombstone) */ }
Stroke   = { id /*'st_…'*/, by /*작성자 id*/, tool /*'pen'|'highlight'|'eraser'*/, color, size, ts, points: [{x,y,p}] /* 0..1, 소수 4자리로 반올림 */ }
Text     = { id /*'tx_…'*/, by, x, y, value, size, color, ts }
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
lessons(id pk, teacher_id fk, title, created_at, updated_at)
slides(id pk, lesson_id fk cascade, position, type default 'ink', title, config jsonb, bg_url, bg_path, thumb_url, gs_embed, mode, base_strokes jsonb, base_texts jsonb,
       unique(lesson_id, position) DEFERRABLE INITIALLY DEFERRED)
sessions(id pk, lesson_id fk, teacher_id fk, title, status, flow, current_slide, groups jsonb, activity jsonb, rev bigint default 0,
         slides_snapshot jsonb /*레거시: v2는 '[]'*/, started_at, ended_at, last_writer)
session_snapshots(session_id pk fk cascade, slides jsonb)          -- realtime 미발행
session_participants(session_id, student_id, joined_at, pk(session_id, student_id))
slide_records(id, session_id fk cascade, slide_id, scope, scope_id NOT NULL /* whole → session_id */, strokes jsonb, texts jsonb, removed jsonb default '[]',
              last_writer, updated_at, unique(session_id, slide_id, scope, scope_id))
responses(id bigserial, session_id fk cascade, slide_id, student_id, item_key default '', payload jsonb, score numeric, correct bool, time_ms int,
          last_writer, updated_at, unique(session_id, slide_id, student_id, item_key))
view lesson_meta(id, teacher_id, title, created_at, updated_at, slide_count, cover)
realtime publication: sessions, session_participants, slide_records, responses   (lessons/slides/teachers/students 제외)
replica identity FULL: responses, session_participants (DELETE 이벤트에 old 전체)
storage bucket 'slides' public, 5 MB, image/jpeg|png|webp, anon select/insert/update/delete
```

### 3.3 Storage 경로 (캐시 무효화를 위해 쓰기마다 새 경로)

`<lessonId>/<slideId>_<Date.now().toString(36)>.jpg` (본 이미지), 같은 이름 + `_t.jpg` (썸네일 폭 320px).
업로드 옵션 `{ contentType: 'image/jpeg', cacheControl: '31536000', upsert: false }`. 교체 시 이전 path는 best-effort `remove`.

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
export async function cloudListSessionsForStudent(studentId) → session[] (meta)   // 내 기록용

// 참여·필기·응답
export async function cloudAddParticipant(sessionId, studentId)
export function cloudWriteRecord(sessionId, slideId, scope, scopeId, rec)   // 키별 250ms 디바운스(최신만), whole이면 scopeId=sessionId
   // 행 > 700 KB면 저장하지 않고 toast('이 슬라이드의 필기가 너무 많아요') 1회
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
   //   → applyRecord: last_writer===clientId면 무시. whole/group은 id 기준 합집합 병합 + removed 합집합, individual은 원격 채택.
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
export async function fileToSlides(file, lessonId, onProgress) → Slide[]   // PDF(pdf.js 4.0.379, scale 1.6, jpeg 0.85)·이미지 → ink 슬라이드(업로드 완료된 URL)
export function isDataUrl(s)
```

### 5.4 realtime.js (토픽 `rt:session:<id>`, cloud.js의 `db:` 채널과 분리)

```js
export function joinSessionChannel(sessionId, me /*{id, name, role:'teacher'|'student'}*/) → ch
ch.send(event, payload)            // broadcast, self:false. 로컬 모드: BroadcastChannel
ch.on(event, cb) → off              // cb(payload)
ch.online() → Set<studentId>        // presence(role student) — 100ms 디바운스 갱신
ch.onPresence(cb) → off
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
  TeacherLive({ slide, session, ctx }) → { el, destroy?, onActivity?, onResponses?, onSession?, panel? }
  summary?(slide, responses, session, ctx) → HTMLElement      // 기록 화면(읽기 전용)
  validate?(slide) → string|null   // 편집기 경고 문구(예: '정답을 선택하세요'), 시작 시에도 표시
}
```
- `update(patch)`: 코어가 **얕은 병합** `Object.assign(slide, patch)`. `config`를 바꿀 때는 플러그인이 **전체 config 객체**를 넘긴다(`update({ config: { ...slide.config, question } })`). 코어가 300ms 디바운스 저장 + 썸네일 갱신.
- Editor 폼 규칙: 세로 1열, 각 입력은 `.field`, placeholder만(설명 문단 금지). 옵션 추가/삭제는 `.btn-sm`/`.btn-icon`.

### 6.2 host.js — `mountSlideHost`

```js
mountSlideHost({ role /*'student'|'teacher'|'editor'*/, root, slide, session, me, lesson, onEditorUpdate })
  → { update({ slide, session }), destroy(), panel /*TeacherLive.panel|null*/, ctx }
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
- **게임(dino, race)**: `phase:'running'`일 때만 플레이. 교사 `[시작]`(idle→running) / `[종료]`(→ended) / `[다시]`(clearResponses → idle). 결과 `submit(payload, { itemKey:'result', score, correct, timeMs })`. TeacherLive = 리더보드.
- 교사가 `running` 중인 게임 슬라이드에서 다른 슬라이드로 이동하면 teacher.js가 `confirmDialog('게임을 종료하고 넘어갈까요?')` → 예: `ended`로 만든 뒤 이동(코어 규칙: `def.category==='game' && activity.phase==='running'`).

#### 필기 확대·이동 (v2.4)
- 필기 화면(편집기 · 교사 전체 · 학생 · 학생 필기 크게 보기)은 `renderSlide({ zoom:true })`. 스테이지가 보기 영역이고 프레임(배경·텍스트)은 확대된 실제 크기로 배치(원본 해상도로 다시 그려 선명), 캔버스는 보기 영역 크기 비트맵 + `InkCanvas.setView({ox,oy,cw,ch,baseW})`(확대해도 선명·메모리 일정). 제스처 중엔 GPU transform 미리보기 → 손을 떼면 확정.
- 맞춤: 배경이 세로(가로/세로 ≤ 1.25)면 썸네일을 분석해 흰 여백을 뺀 내용 영역이 화면에 꽉 차게(내용이 종이의 25% 미만이거나 읽을 수 없으면 종이 전체). 이동은 종이 안에서만. 회전·크기 변화 시 맞춤 상태면 다시 맞춤.
- 입력: 펜·마우스 = 필기, 한 손가락 = 필기(이 페이지에서 펜을 한 번 쓰면 손바닥 오인 방지로 한 손가락은 무시), 두 손가락 = 확대·이동, 읽기 전용·텍스트 도구는 한 손가락/마우스 끌기 = 이동, Ctrl(⌘)+휠·트랙패드 핀치 = 확대, 휠 = 이동. 확대 배율 1(16:10 전체) ~ 맞춤×4. 지우개 반경은 확대 배율만큼 줄인다. 선 굵기는 확대·이동 화면에서 화면 기준 고정(확대 1배일 때 규칙, 배율은 곱하지 않음) — 쓸 때나 볼 때나 같은 펜은 같은 굵기, 저장 굵기도 펜 값 그대로(기록·썸네일·인쇄는 그림 폭 비례). 제스처 중에도 획 점이 6000개 이하면 매 프레임 다시 그려 굵기가 출렁이지 않음. 확대해서 만든 텍스트만 배율로 나눈 글자 크기로 저장(화면에서 보이는 크기 유지, 최소 2).
- 학생 화면: 스테이지 여백 0, 도구바가 덮는 만큼만 맞춤에서 비움(이동하면 도구바 뒤로도 보임). 가로로 남는 화면이면 도구바를 왼쪽 세로 2열로(낮은 화면은 40px 버튼). 도구바에 `[− 100% +]`(100% = 맞춤, 누르면 맞춤 ↔ 폭 맞춤). 발표(읽기 전용)·교사 화면은 오른쪽 아래 작은 확대 버튼. 필기 화면에서는 페이지 자체 확대를 막는다(`.stu:has(.zoom-view)`).
- 교사 갤러리 보기 `[필기 부분 | 전체]`(기기에 기억, 기본 필기 부분): 필기 부분 = 칸마다 그 학생이 방금 쓰는 곳(최근 20초·최대 12개 획/글자, 교사 첨삭 제외)을 16:10 칸에 확대(최대 2배, 줄 시작부터 필기 끝이 학습지 폭 80% 안이면 왼쪽부터 보여 문제 글이 함께 보임). 가운데 15%·크기 20% 미만 변화는 무시(흔들림 방지), 옮길 때 살짝 페이드. 필기가 없으면 학습지 전체. 칸 필기는 칸 크기 × dpr 캔버스에 보이는 영역만(`paintStrokes({ region, lineK })`, 선 굵기는 칸 폭 기준 고정).
- 교사 갤러리(개별·모둠): 칸 크기를 인원·화면에 맞춰 계산 — 모두 한 화면에 들어오는 배치 중 가장 큰 칸, 그 칸이 200px보다 작아지면 200px 이상으로 두고 스크롤. 칸은 학습지 내용 영역만 잘라 보여 주고(`pageRectFor`, 가로 슬라이드는 전체), 필기 캔버스는 칸 실제 크기 × dpr(최대 2400px).
- 가져오기 해상도: PDF·이미지 긴 변 세로 3000px / 가로 2400px(PDF 배율 1.6~4). 이전에 올린 자료(배율 1.6)는 다시 올려야 선명해진다.

### 6.4 타입별 상세

| type | label | category | config 기본값 |
|---|---|---|---|
| ink | 필기 | basic | `mode:'whole', bg:null, strokes:[], texts:[]` (config `{}`) |
| mcq | 객관식 | interact | `{question:'', options:[{id,text:''}×4], answerIds:[], multiple:false, timerSec:null}` |
| short | 주관식·서술형 | interact | `{question:'', long:false, maxLen:300}` |
| blank | 빈칸 채우기 | interact | `{text:'', caseSensitive:false}` |
| wordcloud | 워드클라우드 | interact | `{prompt:'', maxWords:3}` |
| dragdrop | 분류하기 | interact | `{prompt:'', buckets:[{id,label:'A'},{id,label:'B'}], items:[{id,text:'',bucketId}×4]}` |
| wall | 담벼락 | interact | `{prompt:'', allowColor:true, showNames:true}` |
| link | 웹 링크 | media | `{url:'', title:''}` |
| embed | 임베드 | media | `{html:'', src:''}` |
| video | 동영상 | media | `{url:''}` |
| videoquiz | 동영상 퀴즈 | media | `{url:'', questions:[]}` |
| dino | 공룡 점프 | game | `{questions:[], jumpsPerQuestion:3}` |
| race | 레이싱 퀴즈 | game | `{questions:[], laps:2}` |

**ink** (`js/slides/ink.js`)
- 모드: `none`(발표) 학생 readOnly — **교사 필기는 whole scope에 저장되어 학생에게 실시간 표시**; `whole` 모두 같은 캔버스(scope whole); `individual` 학생 각자(scope individual/studentId); `group` 모둠 공유(scope group/groupId), 미배정 학생은 `모둠을 기다리고 있어요` 한 줄 → 배정되면 자동 전환.
- Student: 캔버스 + (쓰기 가능 모드에서만) 하단 플로팅 도구바: 펜·형광·지우개·텍스트 | 색 6 | 굵기 S/M/L | 되돌리기. 모드 바뀌면 재마운트(키에 모드 포함 — ink는 자체적으로 onActivity에서 scope 키 비교 후 내부 재마운트).
- TeacherLive: 스테이지 = 캔버스(none/whole → whole scope에 교사 필기, 도구바 동일 + `전체 지우기`). individual/group → 스테이지는 배경만 + **갤러리**(학생/모둠 타일 그리드, 이름·온라인 점·미니 캔버스, 레코드 변경 시만 다시 그림) — 타일 탭 → 모달로 크게(교사 첨삭 가능, 해당 scope에 기록). panel: 모드 seg(발표·전체·개별·모둠) + 모둠일 때 `[모둠 편성]`.
- **모둠 편성 모달**: 조 크기 seg `2·3·4·5`(기본 4) + `[랜덤 편성]`(groupStudents(online∪participants, size)) + 칩 **탭→탭** 이동(드래그 금지). 저장 = `patchSession(session, { groups })`.
- Editor: 스테이지에 캔버스 + 도구바(교사 기본 필기), 인스펙터(코어)에 배경 교체·기본 모드 seg를 ink가 `inspector` 필드로 제공(`Editor()` 반환에 `inspector?: HTMLElement` 허용).
- summary: whole 레코드 미니 캔버스 / individual 학생 수 표기 + 갤러리(읽기 전용).
- 저장: `cloudWriteRecord`(250ms 디바운스). 병합은 cloud.js `applyRecord`가 담당, ink는 `viewer.refresh()`.

**mcq**: 옵션 2~6. 정답 표시 = `reveal || phase==='ended' || 접속 학생 전원 응답`(전원 응답 시 교사 클라이언트가 `{phase:'ended', reveal:true, autoRevealed:true}`). 교사 화면 = `columnChart`(가로 색상 선지 타일 + 세로 막대, 막대/타일 탭 → `whoSheet` 응답자 목록). 학생: 질문 + 옵션 카드(`.choice`, 최소 56px, 1탭 선택, multiple이면 토글) + `[제출]`. 제출 후 pill '제출함', 마감 전 변경 가능. 채점 `correct = 집합 동일`, `score = correct?1:0`. reveal: 정답 옵션 `--highlight`, 내 선택 ✓/✗. 교사 스테이지: 질문 + `choiceBars`(옵션별 가로 막대, n·%), reveal 전 회색, 후 정답 `--accent`. activityBar(reveal, timer). validate: 정답 미선택 → '정답을 선택하세요'.

**short**: `long:true`면 textarea(maxLen 2000), 아니면 input(maxLen 300). 학생: 입력 + `[제출]` + 글자 수. 교사 스테이지: 카드 그리드(이름+텍스트, 최신 순). 카드 탭 → 강조 토글 `activity.pinned:[studentId]`. reveal 시 학생은 pinned 카드만 본다. activityBar(reveal, timer).

**blank**: 파싱 `/\[([^\]]+)\]/g`, 대안 `|`(첫 항목이 표시용). 줄바꿈 `<br>`. 입력칸 폭 `max(4, 최장 대안+1)ch`, 밑줄. 비교: trim, 연속 공백 1개, caseSensitive false면 소문자, 전각 숫자→반각. `score = 맞은 수/빈칸 수`, `correct = score===1`. reveal: 맞음 `--ok` 테두리, 틀림 `--danger` + 정답 `--highlight`. 교사: 빈칸별 정답률 막대 + 자주 틀린 답 상위 3. validate: 빈칸 0개 → '[정답]처럼 대괄호로 빈칸을 만드세요'.

**wordcloud**: 단어 trim, 최대 12자, 제출 내 중복 제거, 빈 단어 제외, 집계 키 = 영문 소문자/한글 그대로. 학생: 입력칸 maxWords개 + `[제출]` → 제출 직후 학생도 클라우드를 본다. 교사 스테이지 = 클라우드: 글자 크기 빈도에 따라 14→64px 선형, 상위 60개, 아르키메데스 나선 배치(AABB 충돌 검사), 색 4색 순환(`--ink`,`--accent`,`--ok`,`--warn`). 단어 탭 → 숨기기(`activity.hidden:[key]`). activityBar(timer:false, reveal:false).

**dragdrop (분류하기)**: buckets 2~4, items 2~12. **HTML5 drag API 금지** — pointer 이벤트 + `setPointerCapture` + `position:fixed` 고스트 + `elementFromPoint`로 버킷 판정, `touch-action:none`. 탭 대안: 아이템 탭(선택) → 버킷 탭(이동). 학생: 상단 트레이(섞어서) / 하단 버킷(≤768px 세로). 모두 배치해야 `[제출]` 활성. `score = 맞은 수/전체`, `correct = score===1`. reveal: 틀린 아이템 ✗ + 정답 버킷 라벨. 교사: 아이템별 정답률 막대. activityBar(reveal, timer).

**wall (담벼락)**: 글 = Response(itemKey `post_…`), payload `{text ≤200자, color 0..4, at, author?:'teacher'}`; 댓글 = Response(itemKey `cmt_…`), payload `{postKey, text ≤200자, at, author?}`. 교사도 `submit(…, {asTeacher:true})`로 글·댓글 작성(studentId=교사 id, 이름 '선생님' 배지). activity `{phase('ended'=잠금), pinned:[postKey], order:[postKey]}` — 표시 순서 = 고정 → order에 없는 새 글(최신 순) → order 순. 교사: 포인터 드래그로 위치 이동(마우스 6px, 터치 300ms 길게 누르기), ⋯ 메뉴(고정/해제·삭제), 모든 글·댓글 삭제, `[잠금]`. 학생: `[+ 글쓰기]` sheet, 내 글 수정/삭제, 댓글 작성/내 댓글 삭제. 팔레트 `#fff4c2 #fde2e4 #dbeafe #dcfce7 #ede9fe`. showNames false면 학생 화면에서 이름 숨김(교사 글은 항상 '선생님'). DOM은 itemKey 키로 보존, 순서 변경은 FLIP.

**link**: 전체 영역 iframe + 우상단 `[새 탭에서 열기]` 항상. iframe load가 3초 내 없거나 http(s) 아님 → 제목 + 큰 `[열기]` 버튼만. 프로토콜 없으면 `https://` 보정.

**embed**: 붙여넣은 html에서 첫 `<iframe>`의 src만 추출(`/<iframe[^>]*src=["']([^"']+)/i`), 아니면 입력 자체가 http(s) URL이면 그것을 src로. `javascript:` 거부. 렌더 `<iframe sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-presentation" allow="autoplay; fullscreen; clipboard-write" referrerpolicy="no-referrer-when-downgrade">`. 저장 시 `config.src`에 추출값.

**video**: YouTube(`parseYouTubeId`) → IFrame Player API(`loadYouTubeApi()` 1회 로드), 아니면 `<video controls playsinline>`(mp4/webm). 그 외 → 편집기 경고 '유튜브 또는 mp4 주소만 지원해요'. 학생 자율 재생. 교사 TeacherLive 같은 플레이어.

**videoquiz**: `session.flow==='teacher'`면 교사 페이스 — 영상은 교사 화면에서만 재생, 학생은 `칠판의 영상을 봐주세요`; 시점 도달 시 교사 클라이언트가 일시정지 + `activity.vq={state:'question',qid}`·`vqAsked`, 학생 화면에 문제, `vqRevealed`(전원 응답 시 자동), `[계속 재생]`. `flow==='student'`면 아래 자율 재생. questions `[{id, atSec, kind:'mcq'|'short'|'essay', question, options?:[{id,text}]×4, answerIds?}]` atSec 오름차순. 250ms 폴링(YouTube `getCurrentTime`)/`timeupdate`. 미응답 문제 중 `atSec <= currentTime`이 있으면 일시정지 + 가장 이른 문제 오버레이(탐색으로 건너뛰어도 걸림). 제출 `submit(payload, { itemKey: q.id, correct })` → 닫고 재생. mcq 자동 채점, short(1줄 100자)/essay(여러 줄 1000자) 채점 없음. 교사 panel: 문제별 결과(mcq 막대, 서술 카드). 편집기: URL + 미리보기 플레이어 + `[현재 시점에 문제 추가]`(플레이어 현재 초 → atSec) + 문제 목록(시점 mm:ss 편집 가능).

**dino (공룡 점프)** — `js/slides/dino.js`
- config `{questions:[{id, question, options:[{id,text}]×4, answerIds:[id]}], jumpsPerQuestion:3}`, questions ≥1(validate).
- 입력: 게임 영역 탭/클릭, Space, ArrowUp = 점프(pointerdown, 공중 점프 불가, `touch-action:none`).
- 시작: 교사 `[시작]` → 학생 3·2·1 카운트다운 후 `t0 = performance.now()`. running 중 늦게 들어온 학생도 즉시 플레이.
- 진행: 캔버스(논리 800×240, devicePixelRatio 대응, 폭에 맞춰 스케일). 선인장 1.1~2.0초 랜덤 간격, 기본 속도 320px/s, 문제 하나 풀 때마다 +6%. **장애물을 넘어 통과한 횟수**가 `jumpsPerQuestion`의 배수가 될 때마다 정지 + 문제 오버레이(제한 없음). 답 → 정오 0.8초 표시 → 재개.
- 충돌: 게임오버 아님. `hits += 1`, 0.8초 무적 + 깜빡임, 통과로 세지 않음.
- 종료: 마지막 문제 답 제출 시. `timeMs = performance.now() - t0`. `submit({correct,total,timeMs,hits}, {itemKey:'result', score:correct, correct: correct===total, timeMs})`.
- 순위: correct 내림차순 → timeMs 오름차순 → hits 오름차순. 학생 종료 화면: `3위 / 24명` · 정답 n/Q · 시간 · 충돌.
- broadcast `dino:progress {sid, answered, correct, hits}` 문제 답할 때마다 → 교사 리더보드 실시간('진행 중' 행 포함).
- 그래픽: 픽셀 느낌의 단색 공룡/선인장(크롬 공룡 오마주, 캔버스 도형으로 직접 그림 — 외부 이미지 금지), 땅 선, 구름 약간.

**race (레이싱 퀴즈)** — `js/slides/race.js`
- config `{questions:[{id, question, options:[{id,text}]×4, answerId}], laps:2}` (4지선다 고정, 정답 1개 교사 선택). questions ≥1.
- **조 편성**(교사 `[시작]` 시 1회): `ids = online ∩ participants`(없으면 participants), `groupStudents(ids, 4)` → `activity = { phase:'running', startedAt: Date.now()+3000 /*3초 카운트다운*/, groups:[{id:'g1', name:'1조', memberIds}] }`. n=0이면 toast('참여 학생이 없어요'). lane = memberIds 인덱스(0~3).
- **주행**: 입력 없음. 자동 주행, 기본 속도 = `1랩/12초`. 트랙 = 캔버스 둥근 직사각형(스타디움형) 오벌, 연석(빨강/흰색 줄무늬), 체크 무늬 결승선, 4개 레인. 차는 위에서 본 카트(색 4종: 초록·빨강·파랑·노랑) + 이름표.
- **퀴즈 체크포인트**: Q문항, k번째(1..Q) 문제는 진행도 `laps*k/(Q+1)`(랩 단위)에서 차가 정지하고 4지선다 오버레이(15초 제한, 미응답=오답).
- **정답** = 부스터: 2.5초 동안 속도 ×2.0(불꽃 효과). **오답** = 미끄러짐: 1초 정지(스핀) 후 2.5초 동안 ×0.5.
- **결정적 시뮬레이션 + 이산 이벤트**(위치 스트림 금지): 각 클라이언트는 같은 규칙으로 모든 차를 시뮬레이션한다. 학생은 `race:answer {sid, gid, k, correct, at /* startedAt 기준 ms */}`(문항당 1회)와 `race:finish {sid, gid, lapMs:[…], totalMs, correct, total}`만 보낸다. 수신자는 상대 차가 체크포인트 k에 도달하면 해당 answer 이벤트가 올 때까지 정지 상태로 그린다.
- **랩타임**: 랩 경계 통과 시 `lapMs.push(now - lapStart)`(문제 시간 포함). 결승(진행도 ≥ laps) → `submit({lapMs,totalMs,correct,total,gid}, {itemKey:'result', score:correct, timeMs:totalMs})` + `race:finish`.
- **학생 화면**: 자기 조 트랙만(최대 4대, 이름표, 랩 `1/2`, 지난 랩타임). 미배정(늦게 입장) → `다음 경기에 참여해요`. 결승 후 조 내 순위·랩타임 카드, 다른 차 계속 표시.
- **교사 TeacherLive**: 모든 조의 미니 트랙 그리드(조당 1칸). panel: 조별 표(순위, 이름, 랩1, 랩2, 합계, 정답 n/Q), 조별 우승자 = totalMs 최소(🏆), 미완주 DNF. 버튼 `[시작]` / `[종료]`(미완주 DNF 확정, phase ended) / `[다시]`(clearResponses, idle).
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
| `/student-login` | C | 기억된 학생 있으면 큰 버튼 `홍길동 (6-2-14) · ABC123 입장` + 작은 `다른 사람이에요`. 없으면 폼: 코드(1칸, 자동 대문자, 6자) · 학년/반/번호(`repeat(3,minmax(0,1fr))`, `type=text inputmode=numeric`) · 이름 · `입장` |
| `/student/join?c=CODE` | C | QR. 기억된 학생이면 즉시 입장 시도, 아니면 코드 채운 로그인 폼 |
| `/student` | C | 대기 카드: 교사 이름 · `선생님이 수업을 시작하면 자동으로 들어가요` · `코드 바꾸기` · 하단 작은 `내 기록` |
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
- **수업 자료 카드**: 썸네일(cover) · 제목 · `n장 · 날짜` · `[시작]`(primary) · `⋯` 메뉴(편집, 복제(선택), 삭제). 카드 탭 = 편집기. 새 수업: `[+ 새 수업]` → 제목 promptDialog → 빈 ink 1장으로 생성 → 편집기. `[PDF·이미지로 만들기]` → 파일 선택 → `fileToSlides` 진행률 → 생성 → 편집기.
- **편집기**: 열 때 `lesson.slides===null`이면 `cloudFetchLessonSlides`(진행률 pill). 레일: 썸네일(`def.thumb`), 탭=선택, 길게 누르기/`⋯`=복제·삭제·위/아래(드래그 정렬은 pointer 이벤트로, HTML5 DnD 금지). 레일 하단 `[+ 슬라이드]` → 모달 그리드(카테고리 섹션, 아이콘+라벨, 탭 즉시 현재 뒤에 삽입) · `[+ 파일]`(PDF/이미지 → ink 여러 장). 스테이지 = `mountSlideHost({role:'editor'})`. 인스펙터 = 제목 input + `def.Editor().inspector`(있으면) + validate 경고. 변경 → 300ms 디바운스 `cloudSaveLesson` + 상단 pill `저장됨/저장 중…/저장 실패 [다시]`.
- **시작**: `수업 이름` 입력 창(기본값 = 같은 자료의 직전 수업 이름 또는 자료 제목, 예: '임진왜란 3학년 2반') → `cloudStartSession({lesson, teacher, title})` await → 성공 `/live/:id`, 실패 toast. flow 기본 teacher. 기록 화면에서 이름 바꾸기(patchSession title).
- **수업 진행 `/live/:id`**: 상단 바(좌→우) `←`(대시보드, 수업은 계속) · 제목 · **코드 pill `ABC123`**(탭 → QR 모달: 큰 코드 + QR + URL 복사) · `● 12`(온라인 수, 탭 → drawer 참여 탭) · `◀ 3/12 ▶`(가운데 숫자 탭 → 썸네일 스트립 팝오버로 점프) · (ink일 때만) 모드 seg `발표·전체·개별·모둠` · flow 토글 아이콘(`교사 진행`/`자유 이동`) · `[패널]` · `[종료]`.
  - 스테이지 = `mountSlideHost({role:'teacher'})`. drawer 탭: `활동`(= host.panel, 없으면 탭 숨김) · `참여`(참가자 목록: 온라인 점, 이름, 미응답 표시(응답형일 때), 모둠).
  - 키보드: ←/→ 이동, F 전체화면, Esc 팝오버 닫기.
  - 이동/모드/flow = `patchSession`. 이 화면은 store 구독 → host.update만 호출(재마운트 금지). 1초 interval 금지.
  - `[종료]` → confirmDialog → `cloudEndSession(session,'completed')` → `/teacher/session/:id`.
- **기록 `/teacher/session/:id`**: `cloudFetchSession` → 요약(날짜·참여 n명·슬라이드 n장) + seg `슬라이드별 / 학생별`. 슬라이드별 = 각 슬라이드 `def.summary`. 학생별 = 학생 선택 → 그 학생 ink(읽기 전용) + 응답(정오) 슬라이드 순. `[인쇄]`(슬라이드별 = 화면 그대로, 학생별 = 그 학생 학습지 인쇄) · `[학생 인쇄]`(js/print.js: 1) 슬라이드 선택 2) 학생 선택 → 학생마다 A4 세로, 여백 0 + 시트 안 패딩, 머리글 작게, 오른쪽 위 워터마크 `assets/print-mark.png`. 필기 슬라이드는 16:10 틀에서 학습지 이미지 영역만 잘라 JPEG로 렌더 — A4 세로 학습지는 종이 한 장을 꽉 채움, 가로 슬라이드는 한 장에 2개). `[이어서]`(stopped/completed → `cloudResumeSession` → `/live/:id`) · `[삭제]`.
- **기록 탭**: 세션 목록(제목, 날짜, 참여 n, 상태 pill). 진행 중 세션은 맨 위 `[돌아가기]`.
- **학생 탭**: 이 교사 세션에 참여한 학생 표(학번순) → 행 탭 → 참여 세션 목록.
- **내 코드 탭**: 큰 코드 · QR · `[코드 복사]` `[링크 복사]`.

### 9.2 학생
- **입장**: 코드 정규화 → `cloudFindTeacherByCode`(없으면 '코드를 확인해 주세요') → `cloudJoinStudent`(서버 id 채택, studentProfile 저장 + lastCode) → `cloudFetchLiveSession(teacherId)` → 있으면 `cloudAddParticipant` → `/student/live/:id`; 없으면 `/student`(대기, `watchTeacherLive`로 자동 입장).
- **수업 화면 `/student/live/:id`**: store에 없으면 `cloudFetchSession(id, {forStudentId})`. `subscribeSession` + `joinSessionChannel`(presence) + `send('session:hello')`. 상단 바: 로고(작게) · 제목 · 모드 pill(ink일 때만, `전체`/`개별`/`모둠 · 2모둠`) · `3 / 12`(자유 이동이면 `◀ ▶`) · `나가기`. 스테이지 = `mountSlideHost({role:'student'})`.
  - flow teacher: currentSlide를 따른다. flow student: 로컬 인덱스(처음엔 currentSlide).
  - 세션 status가 live가 아니게 되면 `수업이 끝났어요` 2초 → `/student`(대기: 같은 교사의 다음 수업 자동 입장).
  - `나가기` → 채널 leave → `/student`.
- **내 기록**: `cloudListSessionsForStudent` → 세션 → 읽기 전용 학생별 뷰(교사 기록의 학생별 컴포넌트와 같은 구조를 student.js가 간단히 구현: 슬라이드마다 ink 읽기 전용 / `def.summary`에 내 응답만 넘김).

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
