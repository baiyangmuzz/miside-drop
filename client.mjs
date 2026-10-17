// Folium 模组：MiSide 立体掉落歌词
// 打字机浮现 → 整句说完 → 整行坠落 → 落地停留 → 淡出
//
// 三条约束（违反任意一条都会出错，别改）：
//   1. stage 零 padding/border。绝对定位的包含块是 padding box，测量拿的是 border box，
//      有 padding 就整体错位。边距交给 lineBox 的 max-width。
//   2. 粒子坐标是舞台绝对坐标，与 lineBox 无关。换行时不许清粒子。
//   3. 物理走独立 rAF + 真实 dt 积分。用歌词时钟驱动会随刷新率变速。

const num = (o, k, d, lo, hi) => {
  const v = typeof o[k] === 'number' ? o[k] : d;
  return Math.min(hi, Math.max(lo, v));
};
const bool = (o, k, d) => (typeof o[k] === 'boolean' ? o[k] : d);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// 逐字时间轴：优先 word 级；无逐字数据时按字符均分整行。
const charTimings = (line) => {
  const out = [];
  for (const w of line.words || []) {
    const chars = Array.from(w.text);
    if (!chars.length) continue;
    const dur = Math.max(0.001, w.endTime - w.startTime) / chars.length;
    chars.forEach((char, i) => out.push({ char, start: w.startTime + dur * i }));
  }
  if (out.length) return out;
  const chars = Array.from(line.fullText || '');
  const dur = Math.max(0.001, line.endTime - line.startTime) / chars.length;
  return chars.map((char, i) => ({ char, start: line.startTime + dur * i }));
};

// 种子随机：同一首歌每次挂载得到同一串粒子，刷新不跳变。
const seededRandom = (seed) => {
  let h = 2166136261;
  for (const ch of String(seed || 'miside')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// 灰阶挤出：同色叠层只出光晕，必须明度递减才读作厚度。
const extrude = (daylight) => {
  const [from, to] = daylight ? [150, 245] : [168, 64];
  const shift = daylight ? 2 : 5;
  return Array.from({ length: 7 }, (_, i) => {
    const v = Math.round(from + ((to - from) * i) / 6);
    return `${i + 1}px ${i + 1}px 0 rgb(${v},${v},${v + shift})`;
  }).join(',');
};

const mount = (folium, container, ctx) => {
  const s = ctx.getSettings();
  const mode = s.dropModeV2 === 'word' ? 'word' : 'sentence';
  const fontScale = num(s, 'fontSizeV2', 56, 24, 120) / 56 * ctx.getDisplay().lyricsFontScale;
  const dropDelay = num(s, 'dropDelayV2', 0, -0.5, 3);
  const leadTime = num(s, 'leadTimeV2', 0, -0.3, 0.3);
  const gravity = num(s, 'gravityV2', 1400, 100, 6000);
  const elasticity = num(s, 'elasticityV2', 0.34, 0, 0.85);
  const settleHold = num(s, 'settleHoldV2', 2.5, 0, 10);
  const fadeTime = num(s, 'fadeTimeV2', 1.5, 0.1, 8);
  const groundRatio = num(s, 'groundHeightV2', 0.82, 0.05, 0.99);
  const keepRows = Math.round(num(s, 'keepRowsV2', 2, 0, 8));
  const stackFade = bool(s, 'stackFadeV2', true);
  const glowBoost = bool(s, 'glowBoostV2', true);
  const typeSpeed = num(s, 'typeSpeedV2', 0, 0, 0.5);
  const tiltLimit = num(s, 'flipLimitV2', 16, 0, 45);

  // ── DOM ──
  const stage = document.createElement('div');
  stage.style.cssText = 'position:absolute;inset:0;margin:0;padding:0;border:0;'
    + 'overflow:hidden;pointer-events:none;display:flex;align-items:center;justify-content:center;';

  const fx = document.createElement('div');
  fx.style.cssText = 'position:absolute;inset:0;margin:0;padding:0;pointer-events:none;';

  const lineBox = document.createElement('div');
  lineBox.style.cssText = 'position:relative;max-width:84%;text-align:center;'
    + 'line-height:1.35;letter-spacing:0.04em;';

  const ground = document.createElement('div');
  ground.style.cssText = `position:absolute;left:8%;right:8%;height:1px;top:${groundRatio * 100}%;`
    + 'pointer-events:none;opacity:0.5;';

  fx.appendChild(ground);
  stage.appendChild(fx);
  stage.appendChild(lineBox);
  container.appendChild(stage);

  // ── 状态 ──
  const random = seededRandom(ctx.seed || (ctx.song && ctx.song.id));
  const particles = [];
  let spans = [];
  let timings = [];
  let shownIndex = -2;
  let groundY = 0;
  let boxX = 0;
  let boxY = 0;
  let rafId = 0;
  let lastTs = 0;
  let disposed = false;

  const applyTheme = () => {
    const theme = ctx.getTheme();
    const daylight = !!theme.isDaylight;
    const ink = daylight ? '0,0,0' : '255,255,255';

    lineBox.style.fontFamily = folium.theme.resolveFontStack(theme);
    lineBox.style.fontWeight = String(folium.theme.resolveFontWeight(theme, 700));
    lineBox.style.fontSize = `${56 * fontScale}px`;
    lineBox.style.color = `rgb(${ink})`;
    lineBox.style.textShadow = glowBoost
      ? `${extrude(daylight)},10px 12px 24px ${daylight ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.88)'}`
      : `0 6px 22px ${daylight ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.85)'}`;

    const line = daylight ? 'rgba(0,0,0,0.3)' : 'rgba(255,255,255,0.28)';
    ground.style.background =
      `linear-gradient(90deg,transparent,${line} 18%,${line} 82%,transparent)`;
  };

  // offsetLeft/offsetTop 相对 lineBox（它是 position:relative，即 span 的 offsetParent），
  // 不含页面滚动，也不受祖先 transform 影响。
  const measure = () => {
    for (const sp of spans) {
      sp._x = sp.offsetLeft;
      sp._y = sp.offsetTop;
      sp._w = sp.offsetWidth;
      sp._h = sp.offsetHeight;
    }
    boxX = lineBox.offsetLeft;
    boxY = lineBox.offsetTop;
    groundY = stage.clientHeight * groundRatio;
  };

  // 只保留最近 keepRows 个行号的落地粒子。
  const pruneRows = () => {
    if (!particles.length) return;
    const keep = [];
    for (let i = particles.length - 1; i >= 0; i -= 1) {
      const id = particles[i].lineIdx;
      if (keep.indexOf(id) < 0) {
        if (keep.length >= keepRows) break;
        keep.push(id);
      }
    }
    for (let i = particles.length - 1; i >= 0; i -= 1) {
      const p = particles[i];
      if (!p.settled || keep.indexOf(p.lineIdx) >= 0) continue;
      p.el.remove();
      particles.splice(i, 1);
    }
  };

  // 重建某一行。不碰粒子：它们用绝对坐标，换行后仍在原位继续落。
  const buildLine = (index) => {
    pruneRows();
    lineBox.replaceChildren();
    spans = [];
    timings = [];
    shownIndex = index;

    const line = index >= 0 ? ctx.lines[index] : null;
    if (!line) return;

    timings = charTimings(line);
    for (const t of timings) {
      const sp = document.createElement('span');
      sp.textContent = t.char;
      // visibility 而非 opacity：保留布局尺寸，offsetWidth 才有效。
      sp.style.cssText = 'display:inline-block;white-space:pre;visibility:hidden;';
      lineBox.appendChild(sp);
      spans.push(sp);
    }
    measure();
  };

  // 生成粒子。返回 false = 尺寸无效，调用方不得标记为已落。
  // delay > 0 时粒子先不可见、span 照常显示，到点才接手。
  const spawn = (sp, lineIdx, delay) => {
    if (!(sp._w > 0) || !(sp._h > 0)) return false;
    const x = sp._x + boxX;
    const y = sp._y + boxY;
    const delayMs = Math.max(0, delay * 1000);

    const el = document.createElement('div');
    el.textContent = sp.textContent;
    el.style.cssText = 'position:absolute;left:0;top:0;margin:0;padding:0;border:0;'
      + `font-family:${lineBox.style.fontFamily};font-weight:${lineBox.style.fontWeight};`
      + `font-size:${lineBox.style.fontSize};color:inherit;`
      + 'line-height:1;white-space:pre;will-change:transform,opacity;'
      + 'backface-visibility:hidden;transform-style:preserve-3d;';
    el.style.textShadow = lineBox.style.textShadow;
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    if (delayMs > 0) el.style.opacity = '0';
    fx.appendChild(el);

    // 整行一起落时横向散开要收着，否则像爆开。
    const spread = mode === 'sentence' ? 0.3 : 1;
    particles.push({
      el, span: sp, lineIdx,
      startAt: performance.now() + delayMs,
      started: delayMs <= 0,
      x, y, h: sp._h,
      vx: (random() - 0.5) * 170 * spread,
      vy: -60 - random() * 80,
      rx: 0, ry: 0, rz: 0,
      // 俯仰/偏航给得很小，动感交给 rotateZ（平面翻滚不压缩阴影）。
      vrx: (random() - 0.5) * 56 * spread,
      vry: (random() - 0.5) * 56 * spread,
      vrz: (random() - 0.5) * 300 * spread,
      g: gravity * (0.88 + random() * 0.24),
      rest: elasticity * (0.85 + random() * 0.25),
      settled: false,
      settledAt: 0,
      fade: 1,
    });
    return true;
  };

  // 落掉本行还没落的字。deadline 给 Infinity 表示全部落；
  // 给一个歌词时刻则只落已到点的（逐字模式）。
  const dropLine = (deadline, stagger) => {
    const due = [];
    for (let i = 0; i < spans.length; i += 1) {
      if (spans[i]._dropped) continue;
      if (timings[i].start > deadline) continue;
      due.push(i);
    }
    if (!due.length) return;
    // 必须重测：buildLine 那次是在 span 刚插入时跑的，排版可能还没提交。
    measure();
    due.forEach((i, n) => {
      if (spawn(spans[i], shownIndex, dropDelay + n * stagger)) spans[i]._dropped = true;
    });
  };

  const boundTilt = (p, key, velKey, dt) => {
    p[key] += p[velKey] * dt;
    if (p[key] > tiltLimit) { p[key] = tiltLimit; p[velKey] = -Math.abs(p[velKey]); }
    else if (p[key] < -tiltLimit) { p[key] = -tiltLimit; p[velKey] = Math.abs(p[velKey]); }
  };

  const step = (dt, now) => {
    for (let i = 0; i < particles.length; i += 1) {
      const p = particles[i];

      // 延迟期：不可见、不动，span 继续显示。
      if (!p.started) {
        if (now < p.startAt) continue;
        p.started = true;
        p.el.style.opacity = '1';
        if (p.span) {
          p.span.style.visibility = 'hidden';
          p.span = null;
        }
      }

      if (p.settled) {
        if (!stackFade) continue;
        const held = (now - p.settledAt) / 1000;
        if (held <= settleHold) continue;
        p.fade = 1 - (held - settleHold) / fadeTime;
        if (p.fade <= 0) {
          p.el.remove();
          particles.splice(i, 1);
          i -= 1;
          continue;
        }
        p.el.style.opacity = String(clamp(p.fade, 0, 1));
        continue;
      }

      if (!Number.isFinite(p.y) || p.y > stage.clientHeight + 800) {
        p.el.remove();
        particles.splice(i, 1);
        i -= 1;
        continue;
      }

      p.vy = Math.min(2600, p.vy + p.g * dt);
      p.vx *= Math.pow(0.985, dt * 60);
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      boundTilt(p, 'rx', 'vrx', dt);
      boundTilt(p, 'ry', 'vry', dt);
      p.rz += p.vrz * dt;

      const floor = groundY - p.h;
      if (p.y >= floor) {
        p.y = floor;
        if (Math.abs(p.vy) > 50) {
          p.vy *= -p.rest;
          p.vx *= 0.7;
          p.vrx *= 0.4;
          p.vry *= 0.4;
          p.vrz *= 0.4;
        } else {
          // 落地平躺，厚度正对观众；保留平面旋转，像随手散落。
          Object.assign(p, {
            vy: 0, vx: 0, vrx: 0, vry: 0, vrz: 0, rx: 0, ry: 0,
            settled: true, settledAt: now,
          });
        }
      }

      p.el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`
        + ` rotateX(${p.rx}deg) rotateY(${p.ry}deg) rotateZ(${p.rz}deg)`;
    }
  };

  const frame = (ts) => {
    if (disposed) return;
    rafId = window.requestAnimationFrame(frame);

    const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 1 / 60;
    lastTs = ts;

    const lyric = ctx.currentTime.get() + leadTime;
    const index = ctx.staticMode && ctx.staticLineIndex !== null
      ? ctx.staticLineIndex : ctx.getLineIndex();

    // 换行：先把离开的那行落完再重建。spans 一旦被替换，未落下的字就永久丢失。
    if (index !== shownIndex) {
      if (shownIndex >= 0 && !ctx.staticMode) dropLine(Infinity, 0.014);
      buildLine(index);
    }

    if (ctx.staticMode) {
      for (const sp of spans) sp.style.visibility = 'visible';
      return;
    }

    const line = index >= 0 ? ctx.lines[index] : null;
    if (line) {
      // 打字机：逐字显形。已交给粒子的字不动显隐，由粒子在开始时接管。
      for (let i = 0; i < spans.length; i += 1) {
        const sp = spans[i];
        if (sp._dropped) continue;
        const at = timings[i].start + (mode === 'word' ? i * typeSpeed : 0);
        sp.style.visibility = lyric >= at ? 'visible' : 'hidden';
      }
      // 逐字模式：唱到就落；整句模式：说完整行落。两条路都幂等。
      if (mode === 'word') dropLine(lyric, 0);
      else if (lyric >= line.endTime) dropLine(Infinity, 0.014);
    }

    if (ctx.isPaused()) {
      lastTs = 0;
      return;
    }
    step(dt, ts);
    pruneRows();
  };

  // ── 启动 ──
  applyTheme();
  buildLine(ctx.staticMode && ctx.staticLineIndex !== null ? ctx.staticLineIndex : ctx.getLineIndex());
  rafId = window.requestAnimationFrame(frame);

  // 字体异步就绪会改变 offsetWidth，且无法可靠查询 ready 时机，分多次补测。
  window.requestAnimationFrame(measure);
  window.setTimeout(measure, 120);
  window.setTimeout(measure, 400);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { if (!disposed) measure(); }).catch(() => {});
  }

  const offChanges = ctx.subscribe(() => {
    applyTheme();
    measure();
  });
  const onResize = () => measure();
  window.addEventListener('resize', onResize);

  return () => {
    disposed = true;
    if (rafId) window.cancelAnimationFrame(rafId);
    offChanges();
    window.removeEventListener('resize', onResize);
    for (const p of particles) p.el.remove();
    stage.remove();
  };
};

export default function activate(folium) {
  const handle = folium.registries.visualizers.register({
    id: 'miside-drop',
    label: { 'zh-CN': 'MiSide 掉落', en: 'MiSide Drop' },
    order: 430,
    hostLayers: { background: true, subtitles: true },
    settings: [
      { key: 'dropModeV2', type: 'select', label: { 'zh-CN': '掉落时机', en: 'Drop trigger' },
        description: { 'zh-CN': '整句：打字机逐字出现，说完整行坠落', en: 'Typewriter, then whole-line drop' },
        defaultValue: 'sentence',
        options: [
          { value: 'sentence', label: { 'zh-CN': '整句说完', en: 'Whole line' } },
          { value: 'word', label: { 'zh-CN': '唱到就逐字崩落', en: 'Per word' } },
        ] },
      { key: 'fontSizeV2', type: 'number', label: { 'zh-CN': '字号基准', en: 'Base font size' },
        defaultValue: 56, min: 24, max: 120, step: 1 },
      { key: 'typeSpeedV2', type: 'number', label: { 'zh-CN': '打字机间隔', en: 'Typewriter interval' },
        description: { 'zh-CN': '逐字模式额外的字间隔（秒）', en: 'Extra seconds per char' },
        defaultValue: 0, min: 0, max: 0.5, step: 0.01 },
      { key: 'settleHoldV2', type: 'number', label: { 'zh-CN': '落地停留', en: 'Settle hold' },
        description: { 'zh-CN': '落地后停留多久才开始淡出', en: 'Seconds resting' },
        defaultValue: 2.5, min: 0, max: 10, step: 0.1 },
      { key: 'fadeTimeV2', type: 'number', label: { 'zh-CN': '淡出时长', en: 'Fade time' },
        defaultValue: 1.5, min: 0.1, max: 8, step: 0.1 },
      { key: 'flipLimitV2', type: 'number', label: { 'zh-CN': '翻转幅度上限', en: 'Flip limit' },
        description: { 'zh-CN': '俯仰/偏航上限（度）。调大会更翻腾，但立体厚度会被压扁',
          en: 'Max tilt in degrees; larger flattens the extrusion' },
        defaultValue: 16, min: 0, max: 45, step: 1 },
      { key: 'gravityV2', type: 'number', label: { 'zh-CN': '重力', en: 'Gravity' },
        description: { 'zh-CN': '像素/秒²，越小越慢', en: 'px/s²' },
        defaultValue: 1400, min: 100, max: 6000, step: 50 },
      { key: 'elasticityV2', type: 'number', label: { 'zh-CN': '弹性', en: 'Bounce' },
        defaultValue: 0.34, min: 0, max: 0.85, step: 0.01 },
      { key: 'dropDelayV2', type: 'number', label: { 'zh-CN': '掉落延迟', en: 'Drop delay' },
        description: { 'zh-CN': '触发后再等多久开始掉', en: 'Seconds after trigger' },
        defaultValue: 0, min: -0.5, max: 3, step: 0.01 },
      { key: 'leadTimeV2', type: 'number', label: { 'zh-CN': '提前量', en: 'Lead time' },
        description: { 'zh-CN': '觉得慢了往负调', en: 'Negative = earlier' },
        defaultValue: 0, min: -0.3, max: 0.3, step: 0.01 },
      { key: 'groundHeightV2', type: 'number', label: { 'zh-CN': '地面高度', en: 'Ground height' },
        description: { 'zh-CN': '落点占画面高度的比例', en: 'Floor fraction of height' },
        defaultValue: 0.82, min: 0.05, max: 0.99, step: 0.01 },
      { key: 'keepRowsV2', type: 'number', label: { 'zh-CN': '保留落地行数', en: 'Settled rows kept' },
        defaultValue: 2, min: 0, max: 8, step: 1 },
      { key: 'stackFadeV2', type: 'boolean', label: { 'zh-CN': '落地淡出', en: 'Fade settled' },
        defaultValue: true },
      { key: 'glowBoostV2', type: 'boolean', label: { 'zh-CN': '立体挤出阴影', en: 'Extruded shadow' },
        defaultValue: true },
    ],
    mount: (container, ctx) => mount(folium, container, ctx),
  });

  return () => handle.unregister();
}
