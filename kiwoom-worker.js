// ═══════════════════════════════════════════════════════════════
// 키움 자동매매 Cloudflare Workers
// - fetch: 프록시 (기존)
// - scheduled 1분: 보유종목 현재가 → 손절/익절
// - scheduled 5분: 신규 종목 스캔 → 매수
//
// KV 네임스페이스: TRADE_KV
// Secrets: KIWOOM_APP_KEY, KIWOOM_APP_SECRET, KIWOOM_ACC_NO
// ═══════════════════════════════════════════════════════════════

const IS_PAPER = true; // 모의투자: true / 실전: false
const API_BASE = IS_PAPER ? 'https://mockapi.kiwoom.com' : 'https://api.kiwoom.com';

const ETF_KEYWORDS = ['KODEX','TIGER','KINDEX','KOSEF','ACE','HANARO','SOL','ARIRANG',
  'KBSTAR','TIMEFOLIO','TREX','KTOP','PLUS','WOORI','WON','KOACT','FOCUS','SMART','ACTIVE',
  '인버스','레버리지','선물','채권','국채','금리','달러','골드','원유','리츠'];

// ── 토큰 캐시 ────────────────────────────────────────────────────
let _token = null;
let _tokenExpires = 0;

async function getToken(env) {
  if (_token && Date.now() < _tokenExpires) return _token;
  // KV에서도 확인
  const cached = await env.TRADE_KV.get('token', 'json');
  if (cached && cached.token && Date.now() < cached.expires) {
    _token = cached.token;
    _tokenExpires = cached.expires;
    return _token;
  }
  const res = await fetch(API_BASE + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: env.KIWOOM_APP_KEY,
      secretkey: env.KIWOOM_APP_SECRET
    })
  });
  const d = await res.json();
  if (!d.token && !d.access_token) throw new Error('토큰 발급 실패: ' + JSON.stringify(d));
  _token = d.token || d.access_token;
  _tokenExpires = Date.now() + 11 * 60 * 60 * 1000; // 11시간
  await env.TRADE_KV.put('token', JSON.stringify({ token: _token, expires: _tokenExpires }));
  return _token;
}

// ── API 헬퍼 ─────────────────────────────────────────────────────
async function apiPost(token, path, apiId, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'authorization': 'Bearer ' + token,
      'api-id': apiId,
      'cont-yn': 'N',
      'next-key': ''
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function apiPostRk(token, apiId, body) {
  const res = await fetch(API_BASE + '/api/dostk/rkinfo', {
    method: 'POST',
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'authorization': 'Bearer ' + token,
      'api-id': apiId,
      'cont-yn': 'N',
      'next-key': ''
    },
    body: JSON.stringify(body)
  });
  const nk = res.headers.get('next-key') || '';
  const cy = res.headers.get('cont-yn') || 'N';
  const data = await res.json();
  data._nextKey = nk;
  data._contYn = cy;
  return data;
}

// ── 포지션 KV 저장/불러오기 ──────────────────────────────────────
async function loadPositions(env) {
  const raw = await env.TRADE_KV.get('positions', 'json');
  return raw || {};
}

async function savePositions(env, positions) {
  await env.TRADE_KV.put('positions', JSON.stringify(positions));
}

// ── 설정 불러오기 ────────────────────────────────────────────────
async function loadSettings(env) {
  const raw = await env.TRADE_KV.get('settings', 'json');
  return raw || {
    buyAmt: 500000,
    maxHold: 10,
    maxDays: 5,
    stopLoss: -3,
    takeProfit: 5,
    exitMode: 'fixed',
    trailTrigger: 3,
    trailDrop: 2
  };
}

// ── 장시간 체크 ──────────────────────────────────────────────────
function isMarketOpen() {
  const now = new Date();
  // UTC+9 (KST)
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = kst.getUTCDay(); // 0=일, 6=토
  if (day === 0 || day === 6) return false;
  const h = kst.getUTCHours();
  const m = kst.getUTCMinutes();
  const t = h * 60 + m;
  return t >= 9 * 60 && t < 15 * 60 + 20; // 09:00~15:20 (15:30 전 여유)
}

// ── ETF 필터 ─────────────────────────────────────────────────────
function isETF(name) {
  const n = (name || '').toUpperCase();
  return ETF_KEYWORDS.some(k => n.includes(k.toUpperCase()));
}

// ── 종목 조건 체크 ───────────────────────────────────────────────
function checkS1(s) { return s.price > s.ma5 && s.ma5 > s.ma20 && s.vol > s.vol10 && s.chg >= 3; }
function checkS2(s) { return s.ma5 > s.ma20 && s.ma20 > s.ma60 && s.vol > s.vol5 && s.chg >= 1 && s.chg <= 5; }
function checkS3(s) { return s.ma20 > s.ma60 && s.vol > s.vol10 * 1.5 && s.chg >= 0.5; }

// ── 거래량 상위 후보 수집 ─────────────────────────────────────────
async function fetchCandidates(token) {
  const params = {
    mrkt_tp: '0', sort_tp: '1', mang_stk_incls: '0',
    crd_tp: '0', trde_qty_tp: '0', pric_tp: '0',
    trde_prica_tp: '0', mrkt_open_tp: '1', stex_tp: '0'
  };
  const [r1, r2] = await Promise.all([
    apiPostRk(token, 'ka10030', { ...params, mrkt_tp: '0' }),  // 코스피
    apiPostRk(token, 'ka10030', { ...params, mrkt_tp: '10' })  // 코스닥
  ]);
  const codes = {};
  for (const r of [r1, r2]) {
    const listKey = Object.keys(r).find(k => !k.startsWith('_') && Array.isArray(r[k]) && r[k].length > 0);
    if (!listKey) continue;
    for (const item of r[listKey]) {
      const cd = (item.stk_cd || '').trim().replace(/^A/, '');
      if (!cd || cd.length < 6 || isETF(item.stk_nm || '')) continue;
      codes[cd] = {
        code: cd,
        name: item.stk_nm || cd,
        price: Math.abs(parseInt((item.cur_prc || '0').replace(/\D/g, ''))),
        chg: parseFloat((item.flu_rt || '0').replace(/[^\d.\-]/g, '')),
        vol: parseInt((item.trde_qty || '0').replace(/\D/g, ''))
      };
    }
  }
  return codes;
}

// ── 종목 시세 조회 ───────────────────────────────────────────────
async function fetchStockInfo(token, code, cached) {
  try {
    const d = await apiPost(token, '/api/dostk/stkinfo', 'ka10001', { stk_cd: code });
    if (d.return_code !== 0) return cached || null;
    const price = Math.abs(parseInt((d.cur_prc || '0').toString().replace(/\D/g, '')));
    const chg   = parseFloat((d.flu_rt || '0').toString().replace(/[^\d.\-]/g, ''));
    const vol   = parseInt((d.trde_qty || '0').toString().replace(/\D/g, ''));
    const ma5   = Math.abs(parseInt((d.ma5 || d.bfdy_avg_prc || '0').toString().replace(/\D/g, ''))) || Math.round(price * 0.98);
    const ma20  = Math.abs(parseInt((d.ma20 || '0').toString().replace(/\D/g, ''))) || Math.round(price * 0.96);
    const ma60  = Math.abs(parseInt((d.ma60 || '0').toString().replace(/\D/g, ''))) || Math.round(price * 0.93);
    const vol5  = parseInt((d.avrg_trde_qty_5 || '0').toString().replace(/\D/g, '')) || Math.round(vol * 0.7);
    const vol10 = parseInt((d.avrg_trde_qty || '0').toString().replace(/\D/g, '')) || Math.round(vol * 0.6);
    return { code, name: d.stk_nm || (cached && cached.name) || code, price, chg, vol, vol5, vol10, ma5, ma20, ma60 };
  } catch(e) { return cached || null; }
}

// ── 매수 주문 ────────────────────────────────────────────────────
async function executeBuy(token, env, s, settings) {
  const qty = Math.floor(settings.buyAmt / s.price);
  if (qty < 1) return null;
  const r = await apiPost(token, '/api/dostk/ordr', 'kt10000', {
    dmst_stex_tp: 'KRX',
    stk_cd: s.code,
    ord_qty: String(qty),
    ord_uv: '0',
    trde_tp: '3'
  });
  if (r.return_code === 0) {
    return { name: s.name, buyPrice: s.price, qty, buyDate: Date.now(), currentPrice: s.price, ordNo: r.ord_no || '' };
  }
  console.log(`매수실패: ${s.name} ${r.return_msg}`);
  return null;
}

// ── 매도 주문 ────────────────────────────────────────────────────
async function executeSell(token, code, qty, reason) {
  const r = await apiPost(token, '/api/dostk/ordr', 'kt10001', {
    dmst_stex_tp: 'KRX',
    stk_cd: code,
    ord_qty: String(qty),
    ord_uv: '0',
    trde_tp: '3'
  });
  if (r.return_code === 0) {
    console.log(`매도주문: ${code} ${reason} 주문번호:${r.ord_no}`);
    return true;
  }
  console.log(`매도실패: ${code} ${r.return_msg}`);
  return false;
}

// ── 손절/익절 체크 ───────────────────────────────────────────────
function checkExit(p, curPrice, settings) {
  const pct = (curPrice - p.buyPrice) / p.buyPrice * 100;
  if (settings.exitMode === 'trail') {
    if (!p.highPrice || curPrice > p.highPrice) p.highPrice = curPrice;
    const triggerPct = (p.highPrice - p.buyPrice) / p.buyPrice * 100;
    if (triggerPct >= settings.trailTrigger) {
      const dropPct = (p.highPrice - curPrice) / p.highPrice * 100;
      if (dropPct >= settings.trailDrop) return { sell: true, reason: `트레일링스탑 고점대비-${dropPct.toFixed(1)}%`, pct };
    }
    if (pct <= settings.stopLoss) return { sell: true, reason: `손절 ${pct.toFixed(2)}%`, pct };
  } else {
    if (pct <= settings.stopLoss) return { sell: true, reason: `손절 ${pct.toFixed(2)}%`, pct };
    if (pct >= settings.takeProfit) return { sell: true, reason: `익절 ${pct.toFixed(2)}%`, pct };
  }
  return { sell: false, pct };
}

// ══════════════════════════════════════════════════════════════════
// 1분 Cron: 보유종목 현재가 체크 → 손절/익절
// ══════════════════════════════════════════════════════════════════
async function cronCheckPositions(env) {
  if (!isMarketOpen()) { console.log('장 외 시간 - 포지션 체크 스킵'); return; }
  const token = await getToken(env);
  const positions = await loadPositions(env);
  const settings = await loadSettings(env);
  const codes = Object.keys(positions);
  if (!codes.length) { console.log('보유종목 없음'); return; }

  console.log(`포지션 체크: ${codes.length}종목`);
  let changed = false;

  for (const code of codes) {
    const p = positions[code];
    const s = await fetchStockInfo(token, code, { price: p.currentPrice });
    if (!s || !s.price) continue;

    p.currentPrice = s.price;
    const result = checkExit(p, s.price, settings);
    if (result.sell) {
      const ok = await executeSell(token, code, p.qty, result.reason);
      if (ok) {
        delete positions[code];
        changed = true;
        console.log(`매도완료: ${p.name} ${result.reason} (${result.pct.toFixed(2)}%)`);
      }
    } else {
      if (p.highPrice) positions[code].highPrice = p.highPrice; // 트레일링 고점 갱신
    }
    await new Promise(r => setTimeout(r, 200)); // rate limit
  }

  if (changed || codes.length) await savePositions(env, positions);
}

// ══════════════════════════════════════════════════════════════════
// 5분 Cron: 신규 종목 스캔 → 매수
// ══════════════════════════════════════════════════════════════════
async function cronScanAndBuy(env) {
  if (!isMarketOpen()) { console.log('장 외 시간 - 스캔 스킵'); return; }
  const token = await getToken(env);
  const positions = await loadPositions(env);
  const settings = await loadSettings(env);
  const maxH = settings.maxHold;

  if (Object.keys(positions).length >= maxH) {
    console.log(`최대 보유(${maxH}) 도달 - 스캔 스킵`);
    return;
  }

  console.log('신규 종목 스캔 시작...');
  const candidates = await fetchCandidates(token);
  const codes = Object.keys(candidates).filter(c => !positions[c]);
  console.log(`후보 ${codes.length}종목`);

  for (const code of codes) {
    if (Object.keys(positions).length >= maxH) break;
    const s = await fetchStockInfo(token, code, candidates[code]);
    if (!s || !s.price) continue;
    const matched = checkS1(s) || checkS2(s) || checkS3(s);
    if (matched) {
      const pos = await executeBuy(token, env, s, settings);
      if (pos) {
        positions[code] = pos;
        console.log(`매수완료: ${s.name} ${s.price.toLocaleString()}원 x${pos.qty}주`);
      }
      await new Promise(r => setTimeout(r, 500));
    }
    await new Promise(r => setTimeout(r, 150));
  }

  await savePositions(env, positions);
  console.log(`스캔 완료. 보유: ${Object.keys(positions).length}종목`);
}

// ══════════════════════════════════════════════════════════════════
// 이벤트 핸들러
// ══════════════════════════════════════════════════════════════════
export default {
  // Cron 트리거
  async scheduled(event, env, ctx) {
    const now = new Date();
    const min = now.getUTCMinutes() + (now.getUTCHours() + 9) * 60; // KST 분
    const is5min = now.getUTCMinutes() % 5 === 0;

    if (is5min) {
      // 5분마다: 스캔 + 매수 (포지션 체크도 같이)
      ctx.waitUntil(Promise.all([
        cronCheckPositions(env),
        cronScanAndBuy(env)
      ]));
    } else {
      // 1분마다: 포지션 체크만
      ctx.waitUntil(cronCheckPositions(env));
    }
  },

  // 프록시 fetch (기존 앱용)
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        }
      });
    }

    const url = new URL(request.url);

    // /status → 현재 포지션/설정 조회
    if (url.pathname === '/status') {
      const positions = await loadPositions(env);
      const settings = await loadSettings(env);
      return new Response(JSON.stringify({ positions, settings, time: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // /settings POST → 설정 저장 (앱에서 푸시)
    if (url.pathname === '/settings' && request.method === 'POST') {
      const body = await request.json();
      await env.TRADE_KV.put('settings', JSON.stringify(body));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // /positions POST → 포지션 저장 (앱에서 푸시)
    if (url.pathname === '/positions' && request.method === 'POST') {
      const body = await request.json();
      await env.TRADE_KV.put('positions', JSON.stringify(body));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 기존 프록시
    const isMock = url.search.includes('mock=1');
    const kiwoomBase = isMock ? 'https://mockapi.kiwoom.com' : 'https://api.kiwoom.com';
    const targetPath = url.pathname.replace('/proxy', '');
    const targetUrl = kiwoomBase + targetPath;

    const headers = new Headers(request.headers);
    headers.delete('origin');
    headers.delete('host');
    headers.delete('accept-encoding');
    headers.set('accept-encoding', 'identity');

    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.method !== 'GET' ? request.body : null,
    });

    const data = await response.text();
    if (targetPath.includes('oauth2')) {
      console.log('토큰응답:', response.status, data.substring(0, 200));
    }
    return new Response(data, {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'next-key': response.headers.get('next-key') || '',
        'cont-yn': response.headers.get('cont-yn') || 'N',
      }
    });
  }
};
