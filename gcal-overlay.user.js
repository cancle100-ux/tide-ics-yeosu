// ==UserScript==
// @name         거문도 바람·파고 오버레이 (Google Calendar)
// @namespace    https://cancle100-ux.github.io/tide-ics-yeosu/
// @version      1.0.0
// @description  구글 캘린더 월 화면 위에 거문도 16일 풍속(빨강)·파고(초록)·돌풍(노랑 점선) 실선을 날짜 칸을 가로질러 그린다. Open-Meteo 직접 조회, 30분 갱신.
// @author       tide-ics-yeosu
// @match        https://calendar.google.com/*
// @grant        GM_xmlhttpRequest
// @connect      api.open-meteo.com
// @connect      marine-api.open-meteo.com
// @run-at       document-idle
// @updateURL    https://cancle100-ux.github.io/tide-ics-yeosu/gcal-overlay.user.js
// @downloadURL  https://cancle100-ux.github.io/tide-ics-yeosu/gcal-overlay.user.js
// ==/UserScript==

(function () {
  'use strict';
  const CFG = { lat: 34.0283, lon: 127.3086, past: 7, fut: 16, wsMax: 16, wvMax: 2.5,
                colWind: '#ff4d4f', colWave: '#3ddc84', colGust: '#ffd166', width: 2.5, band: 0.55 /* 칸 높이 중 선 영역 비율(아래쪽) */ };
  const TH = { good: 5, ok: 8, caution: 11 };
  let H = {};          // 'YYYY-MM-DD' -> {ws[24], gust[24], wave[24]}
  let svg = null, raf = 0, lastKey = '';

  // ---- Google Calendar data-datekey 디코드: year=1970+(k>>9), month=(k>>5)&15 (1~12), day=k&31
  const keyToIso = k => { k = +k; const y = 1970 + (k >> 9), m = (k >> 5) & 15, d = k & 31; return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; };

  function gmFetch(url) {
    return new Promise((res, rej) => {
      if (typeof GM_xmlhttpRequest !== 'function') return fetch(url).then(r => r.json()).then(res, rej);
      GM_xmlhttpRequest({ method: 'GET', url, onload: r => { try { res(JSON.parse(r.responseText)); } catch (e) { rej(e); } }, onerror: rej });
    });
  }

  async function load() {
    const base = `latitude=${CFG.lat}&longitude=${CFG.lon}&timezone=Asia%2FSeoul&past_days=${CFG.past}&forecast_days=${CFG.fut}`;
    const [fc, mr] = await Promise.all([
      gmFetch(`https://api.open-meteo.com/v1/forecast?${base}&hourly=wind_speed_10m,wind_gusts_10m&wind_speed_unit=ms`),
      gmFetch(`https://marine-api.open-meteo.com/v1/marine?${base}&hourly=wave_height`).catch(() => null),
    ]);
    const h = fc.hourly, wv = mr && mr.hourly ? Object.fromEntries(mr.hourly.time.map((t, i) => [t, mr.hourly.wave_height[i]])) : {};
    const out = {};
    h.time.forEach((t, i) => { const k = t.slice(0, 10), hr = +t.slice(11, 13);
      (out[k] ||= { ws: Array(24).fill(null), gust: Array(24).fill(null), wave: Array(24).fill(null) });
      out[k].ws[hr] = h.wind_speed_10m[i]; out[k].gust[hr] = h.wind_gusts_10m[i]; out[k].wave[hr] = wv[t] ?? null; });
    H = out; lastKey = ''; schedule();
  }

  function ensureSvg() {
    if (svg && document.body.contains(svg)) return svg;
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    Object.assign(svg.style, { position: 'fixed', left: 0, top: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 2147483000 });
    svg.setAttribute('id', 'geomundo-overlay');
    document.body.appendChild(svg);
    return svg;
  }

  // 월 화면의 날짜 칸: 같은 datekey 요소 중 가장 큰 사각형을 칸으로 채택
  function monthCells() {
    if (!/\/r\/month/.test(location.pathname) && !/\/r\/?(\?|$)/.test(location.pathname + location.search)) { /* 기본 뷰가 월일 수도 있어 계속 진행 */ }
    const byKey = new Map();
    document.querySelectorAll('[data-datekey]').forEach(el => {
      const r = el.getBoundingClientRect(); if (r.width < 60 || r.height < 60) return;
      const k = el.getAttribute('data-datekey'); const prev = byKey.get(k);
      if (!prev || r.width * r.height > prev.w * prev.h) byKey.set(k, { x: r.left, y: r.top, w: r.width, h: r.height, iso: keyToIso(k) });
    });
    return [...byKey.values()].sort((a, b) => a.y - b.y || a.x - b.x);
  }

  function draw() {
    raf = 0;
    const cells = monthCells();
    const s = ensureSvg();
    const sig = cells.map(c => `${c.iso}:${Math.round(c.x)},${Math.round(c.y)},${Math.round(c.w)},${Math.round(c.h)}`).join('|') + '#' + Object.keys(H).length;
    if (sig === lastKey) return; lastKey = sig;
    while (s.firstChild) s.removeChild(s.firstChild);
    if (!cells.length || !Object.keys(H).length) return;
    // 행 묶기 (y 기준)
    const rows = []; cells.forEach(c => { const row = rows.find(r => Math.abs(r[0].y - c.y) < 8); if (row) row.push(c); else rows.push([c]); });
    const mk = (tag, attrs) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
    rows.forEach(row => {
      row.sort((a, b) => a.x - b.x);
      const yBot = row[0].y + row[0].h - 6, yTop = row[0].y + row[0].h * (1 - CFG.band);
      const line = (key, vmax, color, width, dash) => {
        let d = '', pen = false;
        row.forEach(c => { const day = H[c.iso]; for (let hr = 0; hr < 24; hr++) { const v = day ? day[key][hr] : null; if (v == null) { pen = false; continue; }
          const x = c.x + c.w * (hr + 0.5) / 24, y = yBot - (Math.min(v, vmax) / vmax) * (yBot - yTop); d += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' '; pen = true; } });
        if (d) s.appendChild(mk('path', { d, fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', ...(dash ? { 'stroke-dasharray': dash } : {}), style: 'filter: drop-shadow(0 0 2px #000c)' }));
      };
      // 임계선(풍속 8m/s 주의선)만 은은하게
      const yWarn = yBot - (TH.ok / CFG.wsMax) * (yBot - yTop);
      s.appendChild(mk('line', { x1: row[0].x, x2: row[row.length - 1].x + row[row.length - 1].w, y1: yWarn, y2: yWarn, stroke: '#f1c40f', 'stroke-opacity': .35, 'stroke-dasharray': '4 6' }));
      line('gust', CFG.wsMax, CFG.colGust, 1.2, '4 4');
      line('wave', CFG.wvMax, CFG.colWave, CFG.width);
      line('ws', CFG.wsMax, CFG.colWind, CFG.width);
      // 각 칸 우하단 요약 (낮 최대 풍속 / 최대 파고)
      row.forEach(c => { const day = H[c.iso]; if (!day) return;
        const ws = day.ws.slice(5, 18).filter(v => v != null), wv = day.wave.filter(v => v != null); if (!ws.length) return;
        const mx = Math.max(...ws); const col = mx <= TH.good ? '#2ecc71' : mx <= TH.ok ? '#f1c40f' : mx <= TH.caution ? '#e67e22' : '#e74c3c';
        const t = mk('text', { x: c.x + c.w - 4, y: c.y + c.h - 8, 'text-anchor': 'end', 'font-size': 11, 'font-weight': 800, 'font-family': 'Pretendard, "Noto Sans KR", sans-serif', fill: col, style: 'paint-order: stroke; stroke: #000; stroke-width: 3px; stroke-opacity: .7' });
        t.textContent = `💨${mx.toFixed(0)}${wv.length ? ` 〰${Math.max(...wv).toFixed(1)}` : ''}`; s.appendChild(t); });
    });
  }

  function schedule() { if (!raf) raf = requestAnimationFrame(draw); }
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true);
  setInterval(schedule, 1000);
  load().catch(e => console.warn('[geomundo-overlay] load fail', e));
  setInterval(() => load().catch(() => {}), 30 * 60 * 1000);
})();
