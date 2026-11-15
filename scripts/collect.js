'use strict';
/**
 * 공모 자동 수집 러너
 *   node scripts/collect.js          → data/calls.json, data/collect-status.json 생성
 *   COLLECT_DEBUG=1 로 실행하면 소스별 경고를 출력한다.
 *
 * 모든 소스를 병렬(Promise.allSettled)로 돌리고, id로 중복을 제거한 뒤
 * 마감이 30일 넘게 지난 항목을 버리고 마감 오름차순(마감 미상은 뒤)으로 정렬한다.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SOURCES = ['kcap', 'arko', 'ncas', 'kawf', 'gokams', 'arte', 'kocca'].map((k) => require(`./collect/sources/${k}`));

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CALLS = path.join(DATA_DIR, 'calls.json');
const STATUS = path.join(DATA_DIR, 'collect-status.json');

const DAY = 86400000;
const KEEP_PAST_DAYS = 30;
// 기관 내부 행정 공지는 예술인에게 쓸모가 없어 목록에서 뺀다: 직원 채용 · 합격자, 입찰 · 용역 · 우선협상,
// 퇴직연금 사업자 선정, 개인정보 위탁 알림, 청탁금지 · 고객만족도 · 인권영향평가, 시스템 작업 · 로그인 · 본인인증,
// 대학원 신입생 모집 · 입학설명회. 사칭 주의 · 결과 발표 · 마감 안내처럼 예술인이 알아야 할 공지는 남긴다.
const ADMIN_NOT = /직원\s*채용|(?:근로자|계약직|정규직|기간제|인턴)\s*채용|채용\s*(?:공고|면접|서류|전형|합격|결과)|합격자|입찰|낙찰|견적|용역|우선협상|사업자\s*선정|퇴직연금|개인정보\s*(?:처리\s*)?(?:위탁|위수탁)|위탁사항|청탁금지|고객만족도|인권영향평가|본인인증|(?:시스템|서버|홈페이지|누리집)\s*(?:작업|점검|개편|중단)|로그인|회원가입|신입생|입학\s*설명회/;

// 괄호 안(기간 · 시각 · 기관명 · 세부 유형 등)은 빼고 비교한다. '(~10.2.(금) 16:00)'처럼 겹친 괄호도 안쪽부터 지운다.
const BRACKET = /[\[\(（【][^\[\]\(\)（）【】]*[\]\)）】]/g;
function stripBrackets(t) {
  let s = String(t || ''), prev;
  do { prev = s; s = s.replace(BRACKET, ' '); } while (s !== prev);
  return s.replace(/\s+/g, ' ').replace(/\s*-\s*/g, '-').trim();
}
const normTitle = (t) => stripBrackets(t).replace(/[^\w가-힣]/g, '').toLowerCase();
// 제목의 괄호 안 글자들 (세부 유형 이름으로 쓴다)
function bracketParts(t) {
  const out = []; let s = String(t || ''), prev;
  do { prev = s; s = s.replace(BRACKET, (m) => { out.push(m.slice(1, -1).trim()); return ' '; }); } while (s !== prev);
  return out.filter(Boolean);
}

// NCAS 요약('기관 · 대상 개인 · 분야 무용 · 진행중')을 묶을 때 대상 · 분야는 세부 사업 전체를 합쳐 적는다
function mergeNcasSummary(g) {
  const re = /^(.*?) · 대상 (.*?) · 분야 (.*?)((?: · [^·]*)?)$/;
  const ms = g.map((x) => re.exec(String(x.summary || '')));
  if (ms.some((m) => !m)) return '';
  const uni = (i) => [...new Set(ms.flatMap((m) => m[i].split('/').map((v) => v.trim()).filter((v) => v && v !== '-')))].join('/') || '-';
  return `${ms[0][1]} · 대상 ${uni(2)} · 분야 ${uni(3)}${ms[0][4]}`;
}

// 같은 상세 주소를 여러 세부 사업이 함께 쓰면(NCAS 표의 '시각예술우수작가창작지원(신진 · 유망 · 중견)',
// 한국장애인문화예술원 18개 사업, 아르코 '2027년 문학상주작가지원사업' 6개 시설 유형 등) 주소로 만든 id가 겹쳐
// 첫 줄 하나만 남고 나머지 사업이 목록에서 통째로 빠졌다. 같은 id 안에서
//   - 괄호만 다른 세부 유형은 한 줄로 묶고, 제목 뒤에 세부 유형을, 요약에 세부 사업 이름을 적는다.
//   - 이름이나 마감이 다른 사업은 id 뒤에 이름 해시를 붙여 따로 남긴다.
function splitCollisions(items) {
  const byId = new Map();
  for (const it of items) { if (!byId.has(it.id)) byId.set(it.id, []); byId.get(it.id).push(it); }
  const out = [];
  for (const [id, list] of byId) {
    const groups = new Map();
    for (const it of list) {
      const k = normTitle(it.title) + '|' + (it.end || '');
      if (!groups.has(k)) groups.set(k, []);
      const g = groups.get(k);
      if (!g.some((x) => x.title === it.title)) g.push(it); // 같은 제목이 두 번 읽힌 것은 하나로
    }
    for (const [k, g] of groups) {
      let it = g[0];
      if (g.length > 1) {
        const parts = [...new Set(g.flatMap((x) => bracketParts(x.title)))];
        const shown = parts.slice(0, 4).join(' · ') + (parts.length > 4 ? ` 외 ${parts.length - 4}` : '');
        const tags = [...new Set(g.flatMap((x) => x.tags || []))];
        it = {
          ...it,
          title: `${stripBrackets(it.title)}${shown ? ` (${shown})` : ` 외 ${g.length - 1}건`}`,
          who: [...new Set(g.flatMap((x) => x.who || []))],
          tags: tags.length > 1 ? tags.filter((t) => t !== '전체') : tags,
          summary: [mergeNcasSummary(g) || it.summary, `세부 사업 ${g.length}건${parts.length ? ': ' + parts.join(' · ') : ''}`].filter(Boolean).join(' · ').slice(0, 160),
        };
      }
      if (groups.size > 1) it = { ...it, id: `${id}-${crypto.createHash('sha1').update(k).digest('hex').slice(0, 6)}` };
      out.push(it);
    }
  }
  return out;
}

function isValidItem(it) {
  return it && typeof it.id === 'string' && it.id && typeof it.title === 'string' && it.title && typeof it.url === 'string';
}

async function runSource(src) {
  const t0 = Date.now();
  const status = { key: src.meta.key, name: src.meta.name, ok: false, count: 0, ms: 0, error: '' };
  let items = [];
  try {
    const out = await src.collect();
    items = (Array.isArray(out) ? out : []).filter(isValidItem);
    status.ok = true;
    status.count = items.length;
  } catch (e) {
    status.error = String((e && e.message) || e).slice(0, 300);
  }
  status.ms = Date.now() - t0;
  return { status, items };
}

async function main() {
  const updated = new Date().toISOString();
  const results = await Promise.allSettled(SOURCES.map(runSource));

  const statuses = [];
  const merged = new Map();
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      statuses.push(r.value.status);
      for (const it of splitCollisions(r.value.items)) if (!merged.has(it.id)) merged.set(it.id, it);
    } else {
      const src = SOURCES[i];
      statuses.push({ key: src.meta.key, name: src.meta.name, ok: false, count: 0, ms: 0, error: String(r.reason && r.reason.message) });
    }
  });

  // 어느 기관이 하루 실패해도(사이트 점검 · 응답 지연) 그 기관 공고가 목록에서 통째로 사라지지 않도록
  // 직전 calls.json 에 있던 그 기관 공고를 그대로 이어 쓴다. 화면에는 '직전 자료'로 표시된다.
  let prev = [];
  try { prev = JSON.parse(fs.readFileSync(CALLS, 'utf8')).items || []; } catch { prev = []; }
  for (const st of statuses) {
    if (st.ok) continue;
    const old = prev.filter((it) => it.source === st.key && isValidItem(it));
    for (const it of old) if (!merged.has(it.id)) merged.set(it.id, it);
    if (old.length) { st.stale = true; st.count = old.length; }
  }

  // 같은 공고가 여러 기관 게시판에 올라오는 경우(제목이 같고 마감이 같음) 하나만 남긴다. 협회 확인 > ARKO > 나머지 순으로 우선.
  const PRIO = { kcap: 0, arko: 1, ncas: 2, kawf: 3, gokams: 4, arte: 5, kocca: 6 };
  // 한 기관 게시판 안에서 괄호만 다른 제목(예: '공연예술창작주체(중장기단체도약지원)' · '공연예술창작주체(공연장기획제작지원)')은
  // 서로 다른 세부 사업이므로 묶지 않는다. 같은 기관에서는 제목이 글자까지 같을 때만 중복으로 본다.
  const byTitle = new Map();
  for (const it of merged.values()) {
    if (it.source !== 'kcap' && ADMIN_NOT.test(it.title)) continue;
    let key = normTitle(it.title) + '|' + (it.end || '');
    const prev = byTitle.get(key);
    if (prev && prev.source === it.source && prev.title !== it.title) key += '|' + it.id;
    const cur = byTitle.get(key);
    if (!cur || (PRIO[it.source] ?? 9) < (PRIO[cur.source] ?? 9)) byTitle.set(key, it);
  }
  // 2차: 다른 기관 게시판에서 마감일이 같고 한 제목이 다른 제목을 그대로 품고 있으면 같은 공고로 본다
  // (예: '예술산업보증 10월(7차) 공모' ↔ '2026 예술산업보증 10월(7차) 공모 안내(10.1.~10.12.)').
  // 같은 기관 안의 '예술 창제작 발표 지원-문학' ↔ '-문학 외'처럼 서로 다른 사업은 건드리지 않는다.
  // 우선순위가 높은 출처를, 같으면 제목이 짧은 쪽을 남긴다.
  const pool = [...byTitle.values()];
  const drop = new Set();
  const rank = (x) => [(PRIO[x.source] ?? 9), x.title.length];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i], b = pool[j];
      if (!a.end || a.end !== b.end || a.source === b.source || drop.has(a) || drop.has(b)) continue;
      const na = normTitle(a.title), nb = normTitle(b.title);
      if (Math.min(na.length, nb.length) < 8 || !(na.includes(nb) || nb.includes(na))) continue;
      const [ra, rb] = [rank(a), rank(b)];
      drop.add(ra[0] < rb[0] || (ra[0] === rb[0] && ra[1] <= rb[1]) ? b : a);
    }
  }
  const cutoff = Date.now() - KEEP_PAST_DAYS * DAY;
  const items = pool.filter((x) => !drop.has(x))
    .filter((it) => {
      if (!it.end || it.source === 'kcap') return true;
      const t = Date.parse(it.end + 'T23:59:59+09:00');
      return Number.isNaN(t) ? true : t >= cutoff;
    })
    .sort((a, b) => {
      if (a.end && b.end) return a.end < b.end ? -1 : a.end > b.end ? 1 : a.title.localeCompare(b.title, 'ko');
      if (a.end) return -1;
      if (b.end) return 1;
      return (b.posted || '').localeCompare(a.posted || '') || a.title.localeCompare(b.title, 'ko');
    });

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CALLS, JSON.stringify({ updated, count: items.length, items }, null, 2) + '\n');
  fs.writeFileSync(STATUS, JSON.stringify({ updated, sources: statuses }, null, 2) + '\n');

  for (const s of statuses) {
    console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.key.padEnd(7)} ${String(s.count).padStart(3)} items ${String(s.ms).padStart(6)}ms${s.error ? '  ' + s.error : ''}`);
  }
  console.log(`total ${items.length} items → ${path.relative(ROOT, CALLS)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
