/* =========================================================
 * 공부 타이머 — script.js
 * ---------------------------------------------------------
 *  1. 설정 & 유틸리티
 *  2. 기기 저장소 (localStorage 안전 래퍼)
 *  3. 기록 데이터 (세션 저장 · 날짜별 집계)
 *  4. 서버 동기화 (Supabase)
 *  5. 플립 클럭 컴포넌트
 *  6. 타이머 제어 (시작 · 정지 · 자동 저장 · 복구 · 화면 꺼짐 방지)
 *  7. 통계 패널 (계정 · 주간 그래프 · 월간 캘린더)
 *  8. 화면 갱신 · 토스트
 *  9. 로그인 / 회원가입 / 로그아웃
 * 10. 이벤트 연결 & 초기화
 *
 * 데이터 흐름
 *  - 공부 기록은 Supabase 의 study_sessions 테이블에 계정(user_id)별로 저장됩니다.
 *  - 이 기기에는 계정별로 아래 값을 localStorage 에 둡니다.
 *      studyTimer.v2.<user_id>.cache   : 서버에서 받아 온 기록 (빠른 표시·오프라인용)
 *      studyTimer.v2.<user_id>.pending : 아직 서버에 올리지 못한 기록 (연결되면 자동 업로드)
 *      studyTimer.v2.<user_id>.active  : 지금 실행 중인 세션 { startedAt, lastTick }
 *  - 기록 1개 형식:
 *      { id, date: "2026-10-23", startTime: "14:05:12", endTime: "15:40:03",
 *        minutes: 94, seconds: 5691, startedAt: <ms>, endedAt: <ms> }
 *
 * 데모 모드: 주소 뒤에 ?demo 를 붙이면 로그인 없이 1초 = 1분으로 흐르고,
 *            샘플 기록이 채워지며, 아무것도 저장하지 않습니다.
 * ========================================================= */
(() => {
  'use strict';

  /* ---------- 1. 설정 & 유틸리티 ---------- */
  const DEMO = new URLSearchParams(location.search).has('demo');
  const TIME_SCALE = DEMO ? 60 : 1;

  /** config.js 의 Supabase 연결 정보 */
  const CONFIG = (() => {
    const c = window.STUDY_TIMER_CONFIG || {};
    const url = String(c.supabaseUrl || '').trim().replace(/\/+$/, '');
    const key = String(c.supabaseKey || '').trim();
    const ok = /^https:\/\/[^/]+$/.test(url) && key.length > 20 && !/YOUR[-_]/i.test(url + key);
    return { url, key, ok };
  })();

  const TABLE = 'study_sessions';
  const COLUMNS = 'id,date,start_time,end_time,minutes,seconds,started_at,ended_at';
  const PAGE_SIZE = 1000;     // Supabase 기본 최대 행 수
  const UPLOAD_CHUNK = 500;

  // 로그인 기능 이전 버전(v1)이 쓰던 키 — 최초 1회 계정으로 옮길 때 사용
  const LEGACY = {
    sessions: 'studyTimer.sessions.v1',
    active: 'studyTimer.active.v1',
    notice: 'studyTimer.notice.v1',
    backup: 'studyTimer.sessions.v1.backup',
    migrated: 'studyTimer.migrated.v1',
  };

  const TICK_MS = 1000;                // 화면 갱신 주기
  const HEARTBEAT_MS = 5000;           // 실행 중 '살아 있음' 기록 주기
  const STALE_MS = 90 * 1000;          // 이보다 오래 신호가 없으면 비정상 종료된 세션으로 판단
  const MAX_SESSION_MS = 14 * 24 * 3600 * 1000; // 이보다 오래된 실행 기록은 손상된 데이터로 간주
  const PULL_EVERY_MS = 2 * 60 * 1000; // 다른 기기에서 저장한 기록을 받아 오는 주기
  const RETRY_EVERY_MS = 30 * 1000;    // 업로드 실패 시 재시도 주기
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

  const demoEpoch = Date.now();
  /** 현재 시각(ms). 데모 모드에서는 60배 빠르게 흐름 */
  const now = () => (DEMO ? demoEpoch + (Date.now() - demoEpoch) * TIME_SCALE : Date.now());

  const $ = (sel) => document.querySelector(sel);
  const pad2 = (n) => String(n).padStart(2, '0');
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Date → "YYYY-MM-DD" (로컬 시간 기준) */
  const dateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  /** Date → "HH:MM:SS" */
  const timeStr = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  /** 그 주의 월요일 00:00 */
  function startOfWeek(d) {
    const x = startOfDay(d);
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
  }

  /** 초 → "2h 30m" / "45m" / "3h" */
  function fmtShort(sec) {
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h}h ${r}m` : `${h}h`;
  }

  /** 초 → "2시간 30분" / "45분" / "1분 미만" */
  function fmtLong(sec) {
    const m = Math.floor(sec / 60);
    if (m < 1) return '1분 미만';
    const h = Math.floor(m / 60);
    const r = m % 60;
    if (!h) return `${r}분`;
    return r ? `${h}시간 ${r}분` : `${h}시간`;
  }

  const fmtMD = (d) => `${d.getMonth() + 1}.${d.getDate()}`;

  /** 지난 시각 → "방금" / "5분 전" / "2시간 전" */
  function fmtAgo(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return '방금';
    if (s < 3600) return `${Math.floor(s / 60)}분 전`;
    return `${Math.floor(s / 3600)}시간 전`;
  }

  /** 기록마다 붙는 고유 ID (서버에 같은 기록이 두 번 저장되지 않게 함) */
  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    const b = window.crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  /**
   * [start, end) 구간을 자정 기준으로 나눔.
   * 밤 11시 ~ 새벽 1시 세션은 두 날짜에 각각 기록됩니다.
   */
  function splitByDay(startMs, endMs) {
    const out = [];
    let cur = startMs;
    while (cur < endMs) {
      const nextMidnight = startOfDay(new Date(cur));
      nextMidnight.setDate(nextMidnight.getDate() + 1);
      const segEnd = Math.min(endMs, nextMidnight.getTime());
      if (segEnd <= cur) break; // 안전장치
      out.push({ date: dateKey(new Date(cur)), start: cur, end: segEnd });
      cur = segEnd;
    }
    return out;
  }

  /* ---------- 2. 기기 저장소 (localStorage 안전 래퍼) ---------- */
  function createMemoryStorage() {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: (k) => { m.delete(k); },
    };
  }

  // localStorage 를 쓸 수 없는 환경(일부 사생활 보호 모드 등)에서는 메모리에만 보관
  let storageAvailable = true;
  const backend = (() => {
    if (DEMO) return createMemoryStorage();
    try {
      const probe = '__studyTimer_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return window.localStorage;
    } catch (err) {
      storageAvailable = false;
      return createMemoryStorage();
    }
  })();

  let storageWarned = false;
  function warnStorage() {
    if (storageWarned) return;
    storageWarned = true;
    showToast('이 브라우저에서는 기기 저장소를 쓸 수 없어 오프라인 기록이 보관되지 않아요', 5000);
  }

  const store = {
    get(key, fallback) {
      try {
        const raw = backend.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (err) {
        console.warn('[studyTimer] 읽기 실패:', key, err);
        return fallback;
      }
    },
    set(key, value) {
      try {
        backend.setItem(key, JSON.stringify(value));
        return true;
      } catch (err) {
        console.warn('[studyTimer] 저장 실패:', key, err);
        warnStorage();
        return false;
      }
    },
    remove(key) {
      try { backend.removeItem(key); } catch (err) { /* 무시 */ }
    },
  };

  /* ---------- 3. 기록 데이터 ---------- */
  let user = null;               // 로그인한 사용자 { id, email }
  let cache = [];                // 서버와 동기화된 기록
  let pending = [];              // 아직 서버에 올리지 못한 기록
  let sessions = [];             // 화면에 쓰는 전체 기록 (cache + pending)
  let dailyTotals = new Map();   // "YYYY-MM-DD" → 저장된 공부 시간(초)
  let dailyCounts = new Map();   // "YYYY-MM-DD" → 세션 수
  let active = null;             // 실행 중인 세션 { startedAt, lastTick } 또는 null

  /** 계정별 기기 저장소 키 */
  const keyFor = (uid, name) => `studyTimer.v2.${uid}.${name}`;
  const userKey = (name) => keyFor(user ? user.id : 'none', name);

  /** 기록의 공통 필드 검사 (v1 기록 포함) */
  const isBaseRecord = (s) =>
    !!s && typeof s === 'object' &&
    typeof s.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date) &&
    Number.isFinite(s.seconds) && s.seconds >= 0 &&
    Number.isFinite(s.startedAt) && Number.isFinite(s.endedAt);

  const isTimeText = (t) => typeof t === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(t);

  const isValidRecord = (s) =>
    isBaseRecord(s) && typeof s.id === 'string' && s.id.length > 0 &&
    isTimeText(s.startTime) && isTimeText(s.endTime);

  function isValidActive(a) {
    if (!a || typeof a !== 'object') return false;
    const t = now();
    return Number.isFinite(a.startedAt) && Number.isFinite(a.lastTick) &&
      a.lastTick >= a.startedAt &&
      a.startedAt <= t + 60 * 1000 &&
      t - a.startedAt < MAX_SESSION_MS;
  }

  function readRecords(key) {
    const raw = store.get(key, []);
    return Array.isArray(raw) ? raw.filter(isValidRecord) : [];
  }

  /** 같은 id 는 하나로 (뒤쪽 목록이 우선) */
  function mergeById(...lists) {
    const byId = new Map();
    for (const list of lists) for (const r of list) byId.set(r.id, r);
    return [...byId.values()];
  }

  /** 기기 저장소에서 현재 계정의 기록을 다시 읽음 */
  function loadLocal() {
    if (!user) return;
    cache = readRecords(userKey('cache'));
    pending = readRecords(userKey('pending'));
    sessions = mergeById(cache, pending);
    rebuildTotals();
  }

  function rebuildTotals() {
    dailyTotals = new Map();
    dailyCounts = new Map();
    for (const s of sessions) {
      dailyTotals.set(s.date, (dailyTotals.get(s.date) || 0) + s.seconds);
      dailyCounts.set(s.date, (dailyCounts.get(s.date) || 0) + 1);
    }
  }

  function loadActive() {
    if (!user) return null;
    const a = store.get(userKey('active'), null);
    if (a && !isValidActive(a)) store.remove(userKey('active')); // 손상된 값 정리
    return isValidActive(a) ? a : null;
  }

  /** 세션 기록 1개 생성 (저장 형식) */
  function makeRecord(startMs, endMs) {
    const seconds = Math.floor((endMs - startMs) / 1000);
    const end = new Date(endMs);
    // 자정에 끝난 구간은 "24:00:00" 으로 표기 (다음 날 00:00 과 헷갈리지 않도록)
    const endsAtMidnight = endMs === startOfDay(end).getTime() && endMs > startMs;
    return {
      id: uuid(),
      date: dateKey(new Date(startMs)),
      startTime: timeStr(new Date(startMs)),
      endTime: endsAtMidnight ? '24:00:00' : timeStr(end),
      minutes: Math.floor(seconds / 60),
      seconds,
      startedAt: startMs,
      endedAt: endMs,
    };
  }

  /** 구간을 날짜별로 나눠 '업로드 대기'에 넣고 서버로 보냄. 저장된 총 초를 반환 */
  function commitSession(startMs, endMs) {
    const added = [];
    for (const seg of splitByDay(startMs, endMs)) {
      const rec = makeRecord(seg.start, seg.end);
      if (rec.seconds < 1) continue; // 1초 미만(실수로 두 번 누름 등)은 저장하지 않음
      added.push(rec);
    }
    if (!added.length) return 0;

    // 다른 탭이 쓴 내용을 덮어쓰지 않도록 최신 값을 다시 읽고 추가
    store.set(userKey('pending'), readRecords(userKey('pending')).concat(added));
    loadLocal();
    requestSync();
    return added.reduce((s, r) => s + r.seconds, 0);
  }

  /** 날짜별 공부 시간(초): 저장된 기록 + 실행 중인 세션(실시간) */
  function getTotals() {
    if (!active) return dailyTotals;
    const map = new Map(dailyTotals);
    for (const seg of splitByDay(active.startedAt, Math.max(active.startedAt, now()))) {
      map.set(seg.date, (map.get(seg.date) || 0) + (seg.end - seg.start) / 1000);
    }
    return map;
  }

  /* ---------- 4. 서버 동기화 (Supabase) ---------- */
  let sb = null;             // Supabase 클라이언트
  let accessToken = null;    // 페이지를 닫을 때 직접 업로드하는 데 사용
  let signingOut = false;
  const sync = { loading: false, error: null, lastOk: 0, lastPullTry: 0, lastPushTry: 0 };
  let syncChain = Promise.resolve();

  const cloudReady = () => !!(sb && user && !DEMO && !signingOut);
  const stillUser = (uid) => !!(user && user.id === uid && !signingOut);

  /** 기록 ↔ DB 행 변환 */
  const toRow = (r, uid) => ({
    id: r.id,
    user_id: uid,
    date: r.date,
    start_time: r.startTime,
    end_time: r.endTime,
    minutes: r.minutes,
    seconds: r.seconds,
    started_at: new Date(r.startedAt).toISOString(),
    ended_at: new Date(r.endedAt).toISOString(),
  });

  const fromRow = (row) => ({
    id: row.id,
    date: row.date,
    startTime: String(row.start_time || '').slice(0, 8),
    endTime: String(row.end_time || '').slice(0, 8),
    minutes: Number(row.minutes),
    seconds: Number(row.seconds),
    startedAt: Date.parse(row.started_at),
    endedAt: Date.parse(row.ended_at),
  });

  /** 동기화 작업을 한 줄로 세워 차례로 실행 (동시에 실행되며 꼬이지 않도록) */
  function runSyncStrict(task) {
    const p = syncChain.then(task);
    syncChain = p.catch(() => {});
    return p;
  }

  function runSync(task) {
    return runSyncStrict(task).catch((err) => {
      sync.error = err || new Error('sync failed');
      console.warn('[studyTimer] 동기화 실패:', err);
    });
  }

  /**
   * 업로드 대기 기록을 올리고, pull 이면 서버의 전체 기록을 다시 받아 옴.
   * 실패해도 기록은 이 기기에 남아 있다가 다음 시도 때 다시 올라갑니다.
   */
  function requestSync({ pull = false } = {}) {
    if (!cloudReady()) return Promise.resolve();
    const uid = user.id;
    sync.lastPushTry = Date.now();
    if (pull) sync.lastPullTry = Date.now();
    return runSync(async () => {
      if (!stillUser(uid)) return;
      await pushPending(uid);
      if (pull) await pullAll(uid);
      sync.error = null;
      sync.lastOk = Date.now();
    }).then(afterDataChange);
  }

  async function pushPending(uid) {
    const batch = readRecords(keyFor(uid, 'pending'));
    for (let i = 0; i < batch.length; i += UPLOAD_CHUNK) {
      const chunk = batch.slice(i, i + UPLOAD_CHUNK);
      // 같은 id 가 이미 있으면 무시 → 여러 번 보내도 한 번만 저장됨
      const { error } = await sb.from(TABLE)
        .upsert(chunk.map((r) => toRow(r, uid)), { onConflict: 'id', ignoreDuplicates: true });
      if (error) throw error;

      // 올라간 기록: 업로드 대기 → 동기화 완료 목록으로 이동
      const sent = new Set(chunk.map((r) => r.id));
      store.set(keyFor(uid, 'pending'), readRecords(keyFor(uid, 'pending')).filter((r) => !sent.has(r.id)));
      if (stillUser(uid)) store.set(keyFor(uid, 'cache'), mergeById(readRecords(keyFor(uid, 'cache')), chunk));
    }
    if (stillUser(uid)) loadLocal();
  }

  async function pullAll(uid) {
    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await sb.from(TABLE)
        .select(COLUMNS)
        .eq('user_id', uid)
        .order('started_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < PAGE_SIZE) break;
    }
    if (!stillUser(uid)) return;
    store.set(keyFor(uid, 'cache'), rows.map(fromRow).filter(isValidRecord));
    loadLocal();
  }

  /**
   * 페이지가 닫히는 순간에는 일반 요청이 끊길 수 있어서,
   * 브라우저가 페이지를 닫은 뒤에도 끝까지 보내 주는 keepalive 요청으로 직접 업로드.
   * (실패해도 기록은 기기에 남아 있다가 다음에 열 때 올라감)
   */
  function beaconFlush() {
    if (!cloudReady() || !accessToken) return;
    const batch = readRecords(userKey('pending')).slice(0, 50);
    if (!batch.length) return;
    try {
      fetch(`${CONFIG.url}/rest/v1/${TABLE}?on_conflict=id`, {
        method: 'POST',
        keepalive: true,
        headers: {
          apikey: CONFIG.key,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=ignore-duplicates,return=minimal',
        },
        body: JSON.stringify(batch.map((r) => toRow(r, user.id))),
      }).catch(() => {});
    } catch (err) { /* 다음에 열 때 다시 업로드 */ }
  }

  /** 로그인 기능 이전(v1)에 이 기기에 쌓인 기록을 최초 1회 계정으로 옮김 */
  function migrateLegacy() {
    if (DEMO || !user || store.get(LEGACY.migrated, null)) return;
    const raw = store.get(LEGACY.sessions, null);
    const list = Array.isArray(raw) ? raw.filter(isBaseRecord) : [];
    if (!list.length) return;

    const total = list.reduce((s, r) => s + r.seconds, 0);
    const ok = window.confirm(
      `이 기기에 로그인 전에 저장한 공부 기록 ${list.length}개(총 ${fmtLong(total)})가 있어요.\n` +
      `지금 로그인한 계정(${user.email})으로 옮길까요?\n\n` +
      '[취소]를 누르면 옮기지 않으며, 다시 묻지 않아요.'
    );
    store.set(LEGACY.migrated, { at: Date.now(), userId: ok ? user.id : null });
    if (!ok) return;

    const recs = list.map((r) => ({
      id: uuid(),
      date: r.date,
      startTime: isTimeText(r.startTime) ? r.startTime : timeStr(new Date(r.startedAt)),
      endTime: isTimeText(r.endTime) ? r.endTime : timeStr(new Date(r.endedAt)),
      minutes: Math.floor(r.seconds / 60),
      seconds: Math.floor(r.seconds),
      startedAt: r.startedAt,
      endedAt: r.endedAt,
    }));
    store.set(userKey('pending'), readRecords(userKey('pending')).concat(recs));
    store.set(LEGACY.backup, raw);     // 혹시 모를 상황에 대비해 원본은 백업으로 보관
    store.remove(LEGACY.sessions);
    loadLocal();
    showToast(`기존 기록 ${recs.length}개를 계정으로 옮기고 있어요`);
  }

  /* ---------- 5. 플립 클럭 컴포넌트 ---------- */

  /** CSS 의 --flip-duration 값을 ms 로 읽음 (CSS 한 곳만 바꾸면 JS 타이밍도 따라감) */
  function readFlipMs() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--flip-duration').trim();
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0) return 700;
    return raw.endsWith('ms') ? n : n * 1000;
  }
  const FLIP_MS = readFlipMs();

  /**
   * 숫자 카드 1개.
   *  - 정적 윗면: 새 숫자 / 정적 아랫면: 이전 숫자
   *  - 윗날개(이전 숫자)가 앞으로 넘어가고, 아랫날개(새 숫자)가 내려와 덮음
   */
  function createFlipDigit(initial) {
    const el = document.createElement('div');
    el.className = 'flip';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML =
      '<div class="flip__face flip__top"><span></span></div>' +
      '<div class="flip__face flip__bottom"><span></span></div>' +
      '<div class="flip__face flip__flap-top"><span></span></div>' +
      '<div class="flip__face flip__flap-bottom"><span></span></div>';
    const [top, bottom, flapTop, flapBottom] = el.querySelectorAll('span');

    let value = String(initial);
    let timer = null;

    function paint(t, b, ft, fb) {
      top.textContent = t;
      bottom.textContent = b;
      flapTop.textContent = ft;
      flapBottom.textContent = fb;
    }

    /** 진행 중인 애니메이션을 끝내고 모든 면을 현재 값으로 맞춤 */
    function settle() {
      clearTimeout(timer);
      timer = null;
      el.classList.remove('is-flipping');
      paint(value, value, value, value);
    }

    function set(next, animate) {
      next = String(next);
      if (timer) settle(); // 이전 플립이 끝나기 전에 또 바뀌면 즉시 마무리
      if (next === value) return;

      const prev = value;
      value = next;

      // 애니메이션이 필요 없거나 탭이 보이지 않을 때는 바로 교체
      if (!animate || document.hidden) {
        settle();
        return;
      }

      paint(next, prev, prev, next);
      void el.offsetWidth; // 리플로우: 날개가 시작 위치에서 출발하도록
      el.classList.add('is-flipping');
      timer = setTimeout(settle, FLIP_MS + 60);
    }

    paint(value, value, value, value);
    return { el, set };
  }

  /** 시 : 분 플립 클럭 (카드 4개) */
  const clock = (() => {
    const root = $('#clock');
    const digits = [0, 1, 2, 3].map(() => createFlipDigit('0'));
    root.querySelector('[data-group="hours"]').append(digits[0].el, digits[1].el);
    root.querySelector('[data-group="minutes"]').append(digits[2].el, digits[3].el);

    let current = null;
    return {
      set(h, m, animate = true) {
        const str = pad2(h) + pad2(m);
        if (str === current) return;
        const shouldAnimate = animate && current !== null;
        [...str].forEach((ch, i) => digits[i].set(ch, shouldAnimate));
        current = str;
        root.setAttribute('aria-label', `오늘 공부 시간 ${h}시간 ${m}분`);
      },
      /** 다음 표시를 애니메이션 없이 (계정 전환 등) */
      reset() { current = null; },
    };
  })();

  /* ---------- 6. 타이머 제어 ---------- */
  let lastBeat = 0;

  function startTimer() {
    if (active || !user) return;
    const t = now();
    active = { startedAt: t, lastTick: t };
    lastBeat = Date.now();
    store.set(userKey('active'), active);
  }

  /** 실행 중인 세션을 endAt 까지로 저장하고 정지. 저장된 초를 반환 */
  function stopTimer(endAt = now()) {
    if (!active) return 0;
    const startedAt = active.startedAt;
    active = null;
    store.remove(userKey('active'));
    return commitSession(startedAt, Math.max(startedAt, endAt));
  }

  function toggleTimer() {
    if (!user) return;
    if (active) {
      const sec = stopTimer();
      if (sec > 0) showToast(`세션 저장됨 · ${fmtLong(sec)}`);
    } else {
      startTimer();
    }
    render(); // 통계 패널이 열려 있으면 render() 안에서 함께 갱신됨
    updateWakeLock();
  }

  /** 실행 중에 주기적으로 '마지막 확인 시각'을 남김 (페이지가 갑자기 꺼졌을 때 복구 기준) */
  function heartbeat(force = false) {
    if (!active) return;
    if (!force && Date.now() - lastBeat < HEARTBEAT_MS) return;
    lastBeat = Date.now();

    // 그사이 다른 탭에서 정지했다면, 덮어써서 되살리지 않고 저장소 상태를 따름
    const stored = store.get(userKey('active'), null);
    if (!stored || stored.startedAt !== active.startedAt) {
      loadLocal();
      active = loadActive();
      return;
    }

    active.lastTick = now();
    store.set(userKey('active'), active);
  }

  /**
   * 페이지를 열 때 남아 있는 '실행 중' 기록 처리
   *  - 신호가 오래 끊겼다면(브라우저 강제 종료 등): 마지막 확인 시각까지만 저장하고 정지
   *    → 페이지가 닫혀 있던 시간은 공부 시간에 포함되지 않음
   *  - 신호가 최근이라면: 다른 탭에서 실행 중인 것이므로 이어서 표시
   */
  function recoverActive() {
    const a = loadActive();
    active = a;
    if (a && now() - a.lastTick > STALE_MS) {
      const sec = stopTimer(a.lastTick);
      if (sec > 0) showToast(`지난 세션이 정상 종료되지 않아 마지막 기록 시점까지 저장했어요 · ${fmtLong(sec)}`, 5000);
    }
  }

  /** 페이지를 닫을 때 자동 정지한 경우, 다음에 열었을 때 알려줌 */
  function consumeNotice() {
    const n = store.get(userKey('notice'), null);
    if (!n) return;
    store.remove(userKey('notice'));
    if (n.type === 'autostop' && Date.now() - n.at < 12 * 3600 * 1000) {
      showToast(`페이지를 닫아 타이머가 정지되었어요 · ${fmtLong(n.seconds)} 저장됨`, 5000);
    }
  }

  /**
   * 화면 꺼짐 방지 (모바일): 타이머가 도는 동안 화면이 자동으로 꺼지지 않게 함.
   * 지원하지 않는 브라우저에서는 조용히 무시됩니다.
   */
  let wakeLock = null;
  let wakeBusy = false;
  let wakeAgain = false;
  async function updateWakeLock() {
    if (!('wakeLock' in navigator)) return;
    if (wakeBusy) { wakeAgain = true; return; }
    wakeBusy = true;
    try {
      const want = !!(active && user && document.visibilityState === 'visible');
      if (want && !wakeLock) {
        const lock = await navigator.wakeLock.request('screen');
        wakeLock = lock;
        lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
      } else if (!want && wakeLock) {
        const lock = wakeLock;
        wakeLock = null;
        await lock.release();
      }
    } catch (err) {
      wakeLock = null; // 배터리 절약 모드 등으로 거부될 수 있음
    } finally {
      wakeBusy = false;
      if (wakeAgain) { wakeAgain = false; updateWakeLock(); }
    }
  }

  /* ---------- 7. 통계 패널 ---------- */
  const panelState = { open: false, weekOffset: 0, monthOffset: 0, lastKey: '' };
  let panelHideTimer = null;

  const el = {
    bootView: $('#bootView'),
    authView: $('#authView'),
    authTabs: $('#authTabs'),
    authForm: $('#authForm'),
    authEmail: $('#authEmail'),
    authPassword: $('#authPassword'),
    pwToggle: $('#pwToggle'),
    authMsg: $('#authMsg'),
    authSubmit: $('#authSubmit'),
    authSetup: $('#authSetup'),
    stage: $('#stage'),
    menuBtn: $('#menuBtn'),
    overlay: $('#overlay'),
    panel: $('#statsPanel'),
    closeBtn: $('#closeBtn'),
    toggleBtn: $('#toggleBtn'),
    toggleText: $('#toggleText'),
    statusText: $('#statusText'),
    todayLabel: $('#todayLabel'),
    accountAvatar: $('#accountAvatar'),
    accountEmail: $('#accountEmail'),
    syncStatus: $('#syncStatus'),
    logoutBtn: $('#logoutBtn'),
    weekTitle: $('#weekTitle'),
    weekRange: $('#weekRange'),
    weekSummary: $('#weekSummary'),
    weekChart: $('#weekChart'),
    weekPrev: $('#weekPrev'),
    weekNext: $('#weekNext'),
    monthTitle: $('#monthTitle'),
    monthSub: $('#monthSub'),
    monthSummary: $('#monthSummary'),
    calendarGrid: $('#calendarGrid'),
    monthPrev: $('#monthPrev'),
    monthNext: $('#monthNext'),
    resetBtn: $('#resetBtn'),
    toast: $('#toast'),
  };

  function openPanel() {
    if (panelState.open || !user) return;
    clearTimeout(panelHideTimer);
    panelState.open = true;
    panelState.weekOffset = 0;
    panelState.monthOffset = 0;

    el.overlay.hidden = false;
    el.panel.hidden = false;
    void el.panel.offsetWidth; // 리플로우 후 클래스 추가 → 슬라이드 애니메이션
    el.overlay.classList.add('is-open');
    el.panel.classList.add('is-open');

    el.menuBtn.setAttribute('aria-expanded', 'true');
    el.stage.inert = true;   // 패널이 열린 동안 뒤쪽 화면은 포커스/클릭 불가
    el.menuBtn.inert = true;

    updateAccountUI();
    renderStats(true);
    el.closeBtn.focus({ preventScroll: true });

    // 다른 기기에서 저장한 기록이 있을 수 있으니 열 때마다 새로 받아 옴
    if (cloudReady() && Date.now() - sync.lastPullTry > 10 * 1000) requestSync({ pull: true });
  }

  /** @param immediate true 면 애니메이션 없이 즉시 닫음 (로그아웃 등) */
  function closePanel(immediate = false) {
    if (!panelState.open) return;
    panelState.open = false;
    el.overlay.classList.remove('is-open');
    el.panel.classList.remove('is-open');
    el.menuBtn.setAttribute('aria-expanded', 'false');
    el.stage.inert = false;
    el.menuBtn.inert = false;

    const hide = () => {
      if (!panelState.open) {
        el.overlay.hidden = true;
        el.panel.hidden = true;
      }
    };
    clearTimeout(panelHideTimer);
    if (immediate) {
      hide();
    } else {
      el.menuBtn.focus({ preventScroll: true });
      panelHideTimer = setTimeout(hide, 450);
    }
  }

  /** 동기화 상태 문구 */
  function syncLabel() {
    if (DEMO) return '데모 모드 · 기록이 저장되지 않아요';
    if (sync.loading) return '기록을 불러오는 중…';
    if (pending.length) {
      return sync.error ? `업로드 대기 ${pending.length}건 · 연결되면 자동으로 저장돼요` : '저장하는 중…';
    }
    if (sync.error) return '서버에 연결할 수 없어요 · 이 기기의 기록을 표시 중';
    if (sync.lastOk) return `모든 기기와 동기화됨 · ${fmtAgo(sync.lastOk)}`;
    return '';
  }

  function updateAccountUI() {
    if (!user) return;
    const email = DEMO ? '데모 모드' : (user.email || '로그인됨');
    if (el.accountEmail.textContent !== email) el.accountEmail.textContent = email;
    el.accountAvatar.textContent = (DEMO ? 'D' : (user.email || '?').charAt(0)).toUpperCase();
    el.logoutBtn.hidden = DEMO;
    const label = syncLabel();
    if (el.syncStatus.textContent !== label) el.syncStatus.textContent = label;
    el.syncStatus.classList.toggle('is-warn', !DEMO && !!sync.error);
  }

  /** 요약 수치 <dl> 내용 생성 */
  const summaryHTML = (items) =>
    items.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('');

  /** 그래프 눈금: 30분 / 1 / 2 / 3 / 4 / 6시간 중 눈금이 4개 이하가 되는 간격 */
  function niceScale(maxSec) {
    const target = Math.max(maxSec, 3600); // 최소 1시간 축
    const steps = [1800, 3600, 7200, 10800, 14400, 21600];
    const step = steps.find((s) => target / s <= 4) || 21600;
    return { step, top: Math.ceil(target / step) * step };
  }

  function weekTitleText(offset) {
    if (offset === 0) return '이번 주';
    if (offset === -1) return '지난 주';
    return `${-offset}주 전`;
  }

  /** 주간 막대 그래프 (월~일) */
  function renderWeek(totals, animate) {
    const today = startOfDay(new Date(now()));
    const todayKey = dateKey(today);
    const start = addDays(startOfWeek(today), panelState.weekOffset * 7);

    const days = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(start, i);
      const key = dateKey(d);
      return { d, key, sec: totals.get(key) || 0, isToday: key === todayKey, isFuture: d > today };
    });

    el.weekTitle.textContent = weekTitleText(panelState.weekOffset);
    el.weekRange.textContent = `${fmtMD(start)} – ${fmtMD(addDays(start, 6))}`;
    el.weekNext.disabled = panelState.weekOffset >= 0;

    // 요약
    const total = days.reduce((s, x) => s + x.sec, 0);
    const elapsed = days.filter((x) => !x.isFuture).length;
    const best = days.reduce((a, b) => (b.sec > a.sec ? b : a), days[0]);
    el.weekSummary.innerHTML = summaryHTML([
      ['합계', fmtShort(total)],
      ['일 평균', fmtShort(elapsed ? total / elapsed : 0)],
      ['최고', best.sec >= 60 ? `${WEEKDAYS[best.d.getDay()]} · ${fmtShort(best.sec)}` : '–'],
    ]);

    // 그래프
    const maxSec = Math.max(...days.map((x) => x.sec));
    const { step, top } = niceScale(maxSec);

    let grid = '';
    for (let v = 0; v <= top; v += step) {
      grid += `<div class="chart__gridline${v === 0 ? ' is-base' : ''}" style="bottom:${(v / top) * 100}%">` +
        `<span>${v === 0 ? '0' : fmtShort(v)}</span></div>`;
    }

    // 막대 위 숫자는 '오늘'과 '최고값'에만 (나머지는 툴팁으로)
    const labeled = new Set();
    if (maxSec >= 60) labeled.add(days.findIndex((x) => x.sec === maxSec));
    const todayIdx = days.findIndex((x) => x.isToday);
    if (todayIdx >= 0 && days[todayIdx].sec >= 60) labeled.add(todayIdx);

    const cols = days.map((x, i) => {
      const pct = x.sec > 0 ? Math.max((x.sec / top) * 100, 1.5) : 0;
      const tip = `${x.d.getMonth() + 1}월 ${x.d.getDate()}일 (${WEEKDAYS[x.d.getDay()]}) · ${x.sec >= 1 ? fmtLong(x.sec) : '기록 없음'}`;
      const cls = ['chart__col', x.isToday && 'is-today', i < 2 && 'is-start', i > 4 && 'is-end'].filter(Boolean).join(' ');
      return `<div class="${cls}" style="--h:${pct}%" tabindex="0" role="img" aria-label="${tip}">` +
        (pct ? `<div class="chart__bar" style="height:${animate ? 0 : pct}%" data-h="${pct}"></div>` : '') +
        (labeled.has(i) ? `<span class="chart__value">${fmtShort(x.sec)}</span>` : '') +
        `<span class="chart__tip" aria-hidden="true">${tip}</span>` +
        '</div>';
    }).join('');

    const xLabels = days.map((x) => `<span class="${x.isToday ? 'is-today' : ''}">${WEEKDAYS[x.d.getDay()]}</span>`).join('');

    el.weekChart.classList.toggle('is-intro', animate);
    el.weekChart.innerHTML =
      `<div class="chart__plot">${grid}<div class="chart__bars">${cols}</div></div>` +
      `<div class="chart__x" aria-hidden="true">${xLabels}</div>`;

    // 처음 열 때만 막대가 아래에서 자라나는 애니메이션
    if (animate) {
      const bars = el.weekChart.querySelectorAll('.chart__bar');
      void el.weekChart.offsetHeight;
      requestAnimationFrame(() => bars.forEach((b) => { b.style.height = `${b.dataset.h}%`; }));
    }
  }

  /** 월간 캘린더 (월요일 시작) */
  function renderMonth(totals) {
    const today = startOfDay(new Date(now()));
    const todayKey = dateKey(today);
    const first = new Date(today.getFullYear(), today.getMonth() + panelState.monthOffset, 1);
    const year = first.getFullYear();
    const month = first.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const lead = (first.getDay() + 6) % 7; // 1일 앞의 빈 칸 수

    el.monthTitle.textContent = `${year}년 ${month + 1}월`;
    el.monthSub.textContent = panelState.monthOffset === 0 ? '이번 달' : `${-panelState.monthOffset}개월 전`;
    el.monthNext.disabled = panelState.monthOffset >= 0;

    const days = Array.from({ length: daysInMonth }, (_, i) => {
      const d = new Date(year, month, i + 1);
      const key = dateKey(d);
      return { d, key, sec: totals.get(key) || 0, isToday: key === todayKey, isFuture: d > today };
    });

    // 요약
    const total = days.reduce((s, x) => s + x.sec, 0);
    const studied = days.filter((x) => x.sec >= 60).length;
    const elapsed = days.filter((x) => !x.isFuture).length;
    el.monthSummary.innerHTML = summaryHTML([
      ['총 공부 시간', fmtShort(total)],
      ['공부한 날', `${studied}일`],
      ['일 평균', fmtShort(elapsed ? total / elapsed : 0)],
    ]);

    // 칸 밝기: 그 달 최고 기록(최소 1시간) 대비 비율
    const scaleMax = Math.max(3600, ...days.map((x) => x.sec));
    let html = '<div class="day day--blank" aria-hidden="true"></div>'.repeat(lead);

    for (const x of days) {
      const hasTime = x.sec >= 60;
      const alpha = hasTime ? (0.06 + 0.24 * Math.sqrt(x.sec / scaleMax)).toFixed(3) : 0.03;
      const cls = ['day', x.isToday && 'is-today', x.isFuture && 'is-future'].filter(Boolean).join(' ');
      const count = dailyCounts.get(x.key) || 0;
      const label = `${month + 1}월 ${x.d.getDate()}일 ${WEEKDAYS[x.d.getDay()]}요일 · ` +
        (hasTime ? `${fmtLong(x.sec)}${count ? ` (${count}회)` : ''}` : '기록 없음');
      html += `<div class="${cls}" style="--a:${alpha}" title="${label}" aria-label="${label}">` +
        `<span class="day__num">${x.d.getDate()}</span>` +
        `<span class="day__time">${hasTime ? fmtShort(x.sec) : ''}</span>` +
        '</div>';
    }

    const trail = (7 - ((lead + daysInMonth) % 7)) % 7;
    html += '<div class="day day--blank" aria-hidden="true"></div>'.repeat(trail);
    el.calendarGrid.innerHTML = html;
  }

  function renderStats(animate = false) {
    if (!user) return;
    const totals = getTotals();
    renderWeek(totals, animate);
    renderMonth(totals);
  }

  /** 이 계정의 모든 기록 삭제 (서버 + 이 기기) */
  async function resetAll() {
    if (!user) return;
    const ok = window.confirm(DEMO
      ? '데모 기록을 모두 지울까요?'
      : '모든 공부 기록을 삭제할까요?\n이 계정의 모든 기기에서 기록이 사라지며 되돌릴 수 없어요.');
    if (!ok) return;

    const uid = user.id;
    el.resetBtn.disabled = true;
    try {
      if (cloudReady()) {
        await runSyncStrict(async () => {
          const { error } = await sb.from(TABLE).delete().eq('user_id', uid);
          if (error) throw error;
        });
      }
      if (!stillUser(uid) && !DEMO) return;
      active = null;
      store.remove(userKey('active'));
      store.set(userKey('cache'), []);
      store.set(userKey('pending'), []);
      loadLocal();
      afterDataChange();
      renderStats(true);
      updateWakeLock();
      showToast('모든 기록을 삭제했어요');
    } catch (err) {
      console.warn('[studyTimer] 삭제 실패:', err);
      showToast('삭제하지 못했어요. 인터넷 연결을 확인해 주세요');
    } finally {
      el.resetBtn.disabled = false;
    }
  }

  /* ---------- 8. 화면 갱신 · 토스트 ---------- */
  const canHover = window.matchMedia && window.matchMedia('(hover: hover)').matches;

  function render() {
    if (!user) return;
    const t = new Date(now());
    const todayKey = dateKey(t);
    const totals = getTotals();
    const todaySec = totals.get(todayKey) || 0;
    const totalMin = Math.floor(todaySec / 60);
    const h = Math.min(99, Math.floor(totalMin / 60));
    const m = totalMin % 60;

    clock.set(h, m);

    // 실행 상태
    const running = !!active;
    document.body.classList.toggle('is-running', running);
    el.toggleBtn.setAttribute('aria-pressed', String(running));
    el.toggleText.textContent = running ? '정지' : '시작';

    // 날짜 라벨 (자정이 지나면 자동으로 바뀜)
    const dateText = `${t.getMonth() + 1}월 ${t.getDate()}일 ${WEEKDAYS[t.getDay()]}요일`;
    if (el.todayLabel.textContent !== dateText) el.todayLabel.textContent = dateText;

    // 상태줄
    const todayCount = dailyCounts.get(todayKey) || 0;
    let status;
    if (running) {
      status = `공부 중 · 이번 세션 ${fmtLong((now() - active.startedAt) / 1000)}`;
    } else if (sync.loading && !sessions.length) {
      status = '기록을 불러오는 중…';
    } else if (pending.length && sync.error) {
      status = `업로드 대기 ${pending.length}건 · 인터넷이 연결되면 자동 저장돼요`;
    } else if (todayCount) {
      status = `일시정지 · 오늘 ${todayCount}개 세션 저장됨`;
    } else {
      status = canHover ? '시작 버튼 또는 Space 키로 공부를 시작하세요' : '시작 버튼을 눌러 공부를 시작하세요';
    }
    if (el.statusText.textContent !== status) el.statusText.textContent = status;

    // 탭 제목
    const clockText = `${pad2(h)}:${pad2(m)}`;
    const title = running ? `● ${clockText} 공부 중 · 공부 타이머` : '공부 타이머';
    if (document.title !== title) document.title = title;

    // 통계 패널이 열려 있으면 '분'이 바뀔 때마다 실시간 반영
    const statsKey = `${todayKey}|${totalMin}|${running}`;
    if (panelState.open && statsKey !== panelState.lastKey) renderStats(false);
    panelState.lastKey = statsKey;
  }

  /** 기록이 바뀐 뒤(동기화·다른 탭) 화면 전체를 다시 그림 */
  function afterDataChange() {
    if (!user) return;
    render();
    if (panelState.open) {
      renderStats(false);
      updateAccountUI();
    }
  }

  let toastTimer = null;
  function showToast(message, ms = 3200) {
    el.toast.textContent = message;
    el.toast.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('is-show'), ms);
  }

  /* ---------- 9. 로그인 / 회원가입 / 로그아웃 ---------- */
  let authMode = 'login';
  let authBusy = false;
  let bootTimer = null;

  /** 'boot'(확인 중) | 'auth'(로그인 화면) | 'app'(타이머) */
  function showView(view) {
    document.body.dataset.view = view;
    el.bootView.hidden = view !== 'boot';
    el.authView.hidden = view !== 'auth';
    el.stage.hidden = view !== 'app';
    el.menuBtn.hidden = view !== 'app';
  }

  function setAuthMode(mode) {
    authMode = mode;
    el.authTabs.querySelectorAll('[data-mode]').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.mode === mode));
    });
    el.authSubmit.textContent = mode === 'login' ? '로그인' : '회원가입';
    el.authPassword.setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
    el.authPassword.placeholder = mode === 'login' ? '비밀번호' : '6자 이상';
    showAuthMsg('');
  }

  function showAuthMsg(text, type = 'error') {
    el.authMsg.textContent = text;
    el.authMsg.classList.toggle('is-error', !!text && type === 'error');
    el.authMsg.classList.toggle('is-info', !!text && type === 'info');
  }

  function setAuthBusy(busy) {
    authBusy = busy;
    el.authSubmit.disabled = busy;
    el.authEmail.readOnly = busy;
    el.authPassword.readOnly = busy;
    el.authSubmit.textContent = busy ? '확인 중…' : (authMode === 'login' ? '로그인' : '회원가입');
  }

  /** Supabase 오류 → 한국어 안내 */
  function authErrorText(err) {
    const code = String((err && err.code) || '');
    const msg = String((err && err.message) || '').toLowerCase();
    const status = err && err.status;
    if (code === 'invalid_credentials' || msg.includes('invalid login credentials')) return '이메일 또는 비밀번호가 올바르지 않아요';
    if (code === 'email_not_confirmed' || msg.includes('email not confirmed')) return '이메일 인증이 아직 안 됐어요. 받은 메일의 인증 링크를 먼저 눌러 주세요';
    if (code === 'user_already_exists' || msg.includes('already registered')) return '이미 가입된 이메일이에요. 로그인해 주세요';
    if (code === 'weak_password' || msg.includes('password should')) return '비밀번호가 너무 약해요. 6자 이상으로 더 길게 입력해 주세요';
    if (code === 'email_address_invalid' || msg.includes('email address') && msg.includes('invalid')) return '사용할 수 없는 이메일 주소예요';
    if (code === 'signup_disabled' || msg.includes('signups not allowed')) return '지금은 회원가입을 받지 않고 있어요';
    if (status === 429 || code.startsWith('over_')) return '요청이 너무 많아요. 잠시 후 다시 시도해 주세요';
    if (!navigator.onLine || status === 0 || (err && err.name === 'AuthRetryableFetchError') || msg.includes('fetch')) {
      return '서버에 연결할 수 없어요. 인터넷 연결을 확인해 주세요';
    }
    return `문제가 생겼어요: ${(err && err.message) || '알 수 없는 오류'}`;
  }

  async function onAuthSubmit(e) {
    e.preventDefault();
    if (authBusy || !sb) return;

    const email = el.authEmail.value.trim();
    const password = el.authPassword.value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showAuthMsg('이메일 주소를 확인해 주세요');
      el.authEmail.focus();
      return;
    }
    if (password.length < 6) {
      showAuthMsg('비밀번호는 6자 이상이어야 해요');
      el.authPassword.focus();
      return;
    }

    showAuthMsg('');
    setAuthBusy(true);
    try {
      if (authMode === 'login') {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        // 성공하면 onAuthStateChange 가 타이머 화면으로 전환
      } else {
        // 인증 메일의 링크를 누르면 이 페이지로 돌아오도록
        const options = /^https?:$/.test(location.protocol)
          ? { emailRedirectTo: location.origin + location.pathname }
          : undefined;
        const { data, error } = await sb.auth.signUp({ email, password, options });
        if (error) throw error;
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          showAuthMsg('이미 가입된 이메일이에요. 로그인해 주세요');
          setAuthMode('login');
        } else if (!data.session) {
          // Supabase 에서 '이메일 인증'이 켜져 있는 경우
          setAuthMode('login');
          showAuthMsg(`${email} 로 인증 메일을 보냈어요. 메일의 링크를 누른 뒤 로그인해 주세요`, 'info');
        }
      }
    } catch (err) {
      showAuthMsg(authErrorText(err));
    } finally {
      setAuthBusy(false);
    }
  }

  /** 로그인 상태가 바뀔 때마다 호출 (새로고침 직후 포함) */
  function handleSession(session) {
    clearTimeout(bootTimer);
    accessToken = session ? session.access_token : null;
    const next = session && session.user ? session.user : null;

    // 같은 사람의 토큰 갱신 등: 화면은 그대로
    if (next && user && next.id === user.id) {
      user.email = next.email || user.email;
      return;
    }
    if (user) leaveApp();
    if (next) enterApp(next);
    else showView('auth');
  }

  function enterApp(u) {
    user = { id: u.id, email: u.email || '' };
    sync.loading = !DEMO;
    sync.error = null;
    sync.lastOk = 0;

    loadLocal();       // 이 기기에 있던 기록으로 먼저 즉시 표시
    recoverActive();
    consumeNotice();
    clock.reset();
    showView('app');
    render();
    updateWakeLock();

    if (!DEMO) {
      migrateLegacy();
      requestSync({ pull: true }).then(() => {   // 서버의 최신 기록으로 갱신
        sync.loading = false;
        afterDataChange();
      });
    }
  }

  function leaveApp() {
    if (active) stopTimer();  // 실행 중이었다면 저장 (연결되지 않으면 다음 로그인 때 업로드)
    closePanel(true);
    user = null;
    cache = [];
    pending = [];
    sessions = [];
    active = null;
    rebuildTotals();
    updateWakeLock();
    document.body.classList.remove('is-running');
    document.title = '공부 타이머';
    clock.reset();
    el.authPassword.value = '';
    setAuthMode('login');
    showView('auth');
  }

  async function logout() {
    if (!sb || !user || signingOut) return;
    const uid = user.id;
    el.logoutBtn.disabled = true;

    if (active) stopTimer();
    await Promise.race([requestSync(), wait(4000)]); // 남은 기록을 최대 4초까지 업로드 시도

    signingOut = true;
    // 이 기기에 남은 이 계정의 기록 캐시 정리 (업로드 못 한 기록은 남겨 두었다가 다음 로그인 때 업로드)
    store.remove(keyFor(uid, 'cache'));
    store.remove(keyFor(uid, 'active'));
    store.remove(keyFor(uid, 'notice'));
    if (!readRecords(keyFor(uid, 'pending')).length) store.remove(keyFor(uid, 'pending'));

    try {
      await sb.auth.signOut({ scope: 'local' }); // 이 기기만 로그아웃 (다른 기기는 그대로)
    } catch (err) {
      console.warn('[studyTimer] 로그아웃 오류:', err);
    }
    if (user) handleSession(null); // 이벤트가 늦게 오더라도 화면 전환
    signingOut = false;
    el.logoutBtn.disabled = false;
    showToast('로그아웃했어요');
  }

  /* ---------- 데모 모드 (?demo) ---------- */
  function seedDemo(uid) {
    // 매번 같은 샘플이 나오도록 고정 시드 난수
    let seed = 20261023;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    const today = startOfDay(new Date(now()));
    const list = [];
    for (let i = 45; i >= 1; i--) {
      const day = addDays(today, -i);
      if (rand() < 0.2) continue; // 쉬는 날
      const dayEnd = addDays(day, 1).getTime() - 60 * 1000;
      let cursor = new Date(day);
      cursor.setHours(9 + Math.floor(rand() * 3), Math.floor(rand() * 60));
      const count = 1 + Math.floor(rand() * 3);
      for (let k = 0; k < count; k++) {
        const start = cursor.getTime();
        const end = Math.min(dayEnd, start + (25 + Math.floor(rand() * 110)) * 60 * 1000);
        if (end <= start) break;
        list.push(makeRecord(start, end));
        cursor = new Date(end + (20 + Math.floor(rand() * 90)) * 60 * 1000);
      }
    }
    store.set(keyFor(uid, 'cache'), list);

    const badge = document.createElement('div');
    badge.className = 'demo-badge glass';
    badge.textContent = 'DEMO · 1초 = 1분 · 저장 안 됨';
    document.body.appendChild(badge);
  }

  /* ---------- 10. 이벤트 연결 & 초기화 ---------- */
  function bindEvents() {
    el.toggleBtn.addEventListener('click', toggleTimer);
    el.menuBtn.addEventListener('click', openPanel);
    el.closeBtn.addEventListener('click', () => closePanel());
    el.overlay.addEventListener('click', () => closePanel());
    el.resetBtn.addEventListener('click', resetAll);
    el.logoutBtn.addEventListener('click', logout);

    el.weekPrev.addEventListener('click', () => { panelState.weekOffset--; renderWeek(getTotals(), true); });
    el.weekNext.addEventListener('click', () => {
      if (panelState.weekOffset < 0) { panelState.weekOffset++; renderWeek(getTotals(), true); }
    });
    el.monthPrev.addEventListener('click', () => { panelState.monthOffset--; renderMonth(getTotals()); });
    el.monthNext.addEventListener('click', () => {
      if (panelState.monthOffset < 0) { panelState.monthOffset++; renderMonth(getTotals()); }
    });

    // 막대 탭(모바일) → 툴팁 표시/숨김
    el.weekChart.addEventListener('click', (e) => {
      const col = e.target instanceof Element ? e.target.closest('.chart__col') : null;
      el.weekChart.querySelectorAll('.chart__col.is-active').forEach((c) => { if (c !== col) c.classList.remove('is-active'); });
      if (col) col.classList.toggle('is-active');
    });

    // 로그인 화면
    el.authForm.addEventListener('submit', onAuthSubmit);
    el.authTabs.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('[data-mode]') : null;
      if (btn && !authBusy) setAuthMode(btn.dataset.mode);
    });
    el.pwToggle.addEventListener('click', () => {
      const show = el.authPassword.type === 'password';
      el.authPassword.type = show ? 'text' : 'password';
      el.pwToggle.textContent = show ? '숨기기' : '보기';
      el.pwToggle.setAttribute('aria-pressed', String(show));
      el.pwToggle.setAttribute('aria-label', show ? '비밀번호 숨기기' : '비밀번호 보기');
    });

    // 키보드: Esc = 패널 닫기, Space = 시작/정지 (타이머 화면 · 패널이 닫혀 있을 때)
    const isSpace = (e) => e.code === 'Space' || e.key === ' ';
    // 시작/정지 버튼 자체에 포커스가 있으면 브라우저 기본 동작(클릭)에 맡김
    const spaceIsTimerKey = (e) =>
      isSpace(e) && !!user && document.body.dataset.view === 'app' && !panelState.open && e.target !== el.toggleBtn;

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panelState.open) {
        e.preventDefault();
        closePanel();
        return;
      }
      if (!spaceIsTimerKey(e)) return;
      e.preventDefault(); // ··· 버튼에 포커스가 있어도 패널이 열리지 않도록
      if (!e.repeat) toggleTimer();
    });
    // 일부 브라우저는 Space 를 뗄 때 버튼을 클릭하므로 그것도 막음
    document.addEventListener('keyup', (e) => {
      if (spaceIsTimerKey(e)) e.preventDefault();
    });

    // 페이지를 닫거나 새로고침하면: 실행 중인 세션을 그 시점까지 저장하고 정지
    window.addEventListener('pagehide', () => {
      if (!user) return;
      if (active) {
        const sec = stopTimer();
        if (sec > 0) store.set(userKey('notice'), { type: 'autostop', seconds: sec, at: Date.now() });
      }
      beaconFlush();
    });

    // 뒤로가기 캐시(bfcache)로 돌아온 경우 저장소 기준으로 다시 그림
    window.addEventListener('pageshow', (e) => {
      if (!e.persisted || !user) return;
      loadLocal();
      active = loadActive();
      consumeNotice();
      afterDataChange();
      requestSync({ pull: true });
    });

    // 탭이 가려질 때 마지막 확인 시각 기록, 다시 보이면 즉시 갱신 + 다른 기기 기록 받아 오기
    document.addEventListener('visibilitychange', () => {
      if (!user) return;
      if (document.hidden) {
        heartbeat(true);
      } else {
        render();
        if (cloudReady() && Date.now() - sync.lastPullTry > 15 * 1000) requestSync({ pull: true });
      }
      updateWakeLock();
    });

    // 인터넷이 다시 연결되면 밀린 기록 업로드
    window.addEventListener('online', () => requestSync({ pull: true }));

    // 같은 기기의 다른 탭에서 기록이 바뀌면 동기화
    window.addEventListener('storage', (e) => {
      if (DEMO || !user) return;
      if (e.key !== null && !e.key.startsWith(keyFor(user.id, ''))) return;
      if (e.key === userKey('notice')) {
        if (e.newValue) consumeNotice();
        return;
      }
      loadLocal();
      active = loadActive();
      afterDataChange();
      updateWakeLock();
    });
  }

  /** 1초마다: 화면 갱신 + 실행 중 신호 + 주기적 동기화 */
  function tick() {
    if (!user) return;
    heartbeat();
    render();
    if (panelState.open) updateAccountUI();

    if (cloudReady() && !document.hidden) {
      const t = Date.now();
      if (pending.length && t - sync.lastPushTry > RETRY_EVERY_MS) requestSync();
      else if (t - sync.lastPullTry > PULL_EVERY_MS) requestSync({ pull: true });
    }
  }

  function init() {
    bindEvents();
    setInterval(tick, TICK_MS);
    if (!storageAvailable) warnStorage();

    // 데모: 로그인 없이 바로 타이머
    if (DEMO) {
      seedDemo('demo');
      enterApp({ id: 'demo', email: '' });
      return;
    }

    // 이전 버전이 남긴 실행 중/알림 값은 더 이상 쓰지 않음 (기록은 로그인 후 옮기기 제안)
    store.remove(LEGACY.active);
    store.remove(LEGACY.notice);

    showView('auth');
    setAuthMode('login');

    // config.js 미설정
    if (!CONFIG.ok) {
      el.authTabs.hidden = true;
      el.authForm.hidden = true;
      el.authSetup.hidden = false;
      return;
    }

    // Supabase 라이브러리를 불러오지 못함 (오프라인 등)
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      showAuthMsg('로그인 모듈을 불러오지 못했어요. 인터넷 연결을 확인한 뒤 새로고침해 주세요');
      el.authSubmit.disabled = true;
      return;
    }

    sb = window.supabase.createClient(CONFIG.url, CONFIG.key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });

    // 로그인 상태 확인이 끝날 때까지는 '불러오는 중' 표시 (로그인 화면이 깜빡이지 않도록)
    showView('boot');
    bootTimer = setTimeout(() => {
      if (document.body.dataset.view === 'boot') showView('auth');
    }, 6000);

    // 콜백 안에서 바로 다른 Supabase 호출을 하면 멈출 수 있어서 한 박자 늦게 처리
    sb.auth.onAuthStateChange((event, session) => {
      setTimeout(() => handleSession(session), 0);
    });
  }

  init();
})();
