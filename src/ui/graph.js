'use strict';
/**
 * ZeroAPI 演示控制台 · 拓扑连线动画引擎（Canvas 2D，零依赖）
 * ---------------------------------------------------------------------------
 * 视觉语义：
 *   · 左列 = 系统 A（现代 CRM 的 ProductDTO 字段）
 *   · 右列 = 系统 B（老 ERP 的拼音字段）
 *   · 连线 = 求解器找到的同构映射；连线上的粒子沿"右→左"流动，即真实数据流向
 *   · 线中点的小胶囊 = 该字段需要挂的算子（÷100 / ISO / 0-1→✓ …）
 *   · 变红并脉冲 = 该字段发生结构突变，桥接器正在重求解
 */

(function (global) {
  const OP_COLOR = { identity: '#34d399', unit: '#fbbf24', codec: '#22d3ee', type: '#a78bfa', mixed: '#f472b6' };

  class Topo {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.nodes = [];
      this.edges = [];
      this.pairs = [];
      this.revealT = 0;
      this.meta = { source: [], target: [], pairs: 0, fingerprint: '' };
      this.dpr = Math.min(2, global.devicePixelRatio || 1);
      this._resize = this._resize.bind(this);
      this._frame = this._frame.bind(this);
      global.addEventListener('resize', this._resize);
      this._resize();
      this.t0 = performance.now();
      this.frames = 0;
      this.animating = false;
      requestAnimationFrame(this._frame);
    }

    _resize() {
      const r = this.canvas.parentElement.getBoundingClientRect();
      const w = Math.max(320, r.width), h = Math.max(220, r.height);
      this.canvas.width = Math.floor(w * this.dpr);
      this.canvas.height = Math.floor(h * this.dpr);
      this.W = w; this.H = h;
      this.layout();
    }

    // ── 布局 ─────────────────────────────────────────────────────────
    layout() {
      const W = this.W || 600, H = this.H || 400;
      const nodeW = Math.min(206, Math.max(128, W * 0.30));
      const nodeH = 30, gapY = 11;
      const place = (list, side) => {
        const n = list.length;
        const totalH = n * nodeH + (n - 1) * gapY;
        const y0 = Math.max(24, (H - totalH) / 2);
        return list.map((f, i) => ({
          id: `${side}:${f.name}`,
          side,
          name: f.name,
          type: f.type, unit: f.unit, concept: f.concept, comment: f.comment || '',
          sample: f.sample,
          x: side === 'L' ? W * 0.055 : W * 0.945 - nodeW,
          y: y0 + i * (nodeH + gapY),
          w: nodeW, h: nodeH,
          matched: false, glow: 0, flash: 0,
        }));
      };
      const prevNames = new Map(this.nodes.map((n) => [n.id, n]));
      const build = (list, side) => place(list, side).map((n) => {
        const old = prevNames.get(n.id);
        if (old) { n.glow = old.glow; n.flash = old.flash; }
        return n;
      });
      this.nodes = build(this.meta.target, 'L').concat(build(this.meta.source, 'R'));
      this.byId = new Map(this.nodes.map((n) => [n.id, n]));
      this.buildEdges();
    }

    buildEdges() {
      const prev = new Map((this.edges || []).map((e) => [`${e.from}>${e.to}`, e]));
      this.edges = this.pairs.map((p) => {
        const target = this.byId.get(`L:${p.to}`);
        const source = this.byId.get(`R:${p.from}`);
        if (!target || !source) return null;
        target.matched = true; source.matched = true;
        const kind = !p.ops || !p.ops.length ? 'identity'
          : p.ops.some((o) => /cent|yuan|unixS2Ms|unixMs2S/.test(o)) ? 'unit'
          : p.ops.some((o) => /Iso|int01|Bool/.test(o)) ? 'codec' : 'type';
        const key = `${p.from}>${p.to}`;
        const old = prev.get(key);
        return {
          from: `R:${p.from}`, to: `L:${p.to}`,
          x1: source.x, y1: source.y + source.h / 2,
          x2: target.x + target.w, y2: target.y + target.h / 2,
          ops: p.ops || [], labels: p.labels || [],
          sim: p.sim, cost: p.cost, margin: p.margin, sameConcept: p.sameConcept,
          kind, color: OP_COLOR[kind],
          t: old ? 1 : 0,
          particles: old ? old.particles : [0.1, 0.45, 0.8].map((v) => (v + Math.random() * 0.2) % 1),
          flash: 0,
        };
      }).filter(Boolean);
      this.animating = this.edges.some((e) => e.t < 1);
    }

    // ── 对外 API ─────────────────────────────────────────────────────
    setPlan({ target = [], source = [], pairs = [], fingerprint = '' }) {
      this.meta = { target, source, pairs: pairs.length, fingerprint };
      this.pairs = pairs;
      this.layout();
    }

    /** 结构突变：把相关字段染红并脉冲（重求解完成后由 healed 事件复位） */
    flashFields(names, hard = false) {
      const set = new Set(names || []);
      const now = performance.now();
      for (const n of this.nodes) {
        if (set.has(n.name)) { n.flashUntil = now + (hard ? 1500 : 900); }
      }
      for (const e of this.edges) {
        if (set.has(e.from.split(':')[1]) || set.has(e.to.split(':')[1])) e.flashUntil = now + (hard ? 1500 : 900);
      }
      this.animating = true;
    }

    /** 自愈完成：整图做一次绿色呼吸 */
    healPulse() {
      const now = performance.now();
      for (const n of this.nodes) n.healUntil = now + 700;
      this.animating = true;
    }

    /** 无头截图用：跳过入场动画，直接呈现"已完全建立"的画面 */
    snap() {
      for (const e of this.edges) e.t = 1;
      for (const n of this.nodes) n.glow = 1;
      this.revealT = 1;
      this.animating = false;
    }

    stats() {
      return {
        nodes: this.nodes.length,
        edges: this.edges.length,
        revealed: this.edges.filter((e) => e.t >= 1).length,
        dpr: this.dpr,
        frames: this.frames,
        // 把连线上的算子徽章文本暴露出来 —— canvas 内容无法用 --dump-dom 断言，
        // 不导出的话"图上到底画了 ÷100 还是 ×100"就只能靠肉眼看缩略图。
        edgeLabels: this.edges.map((e) => `${e.from.split(':')[1]}→${e.to.split(':')[1]}[${e.labels.join('∘') || 'identity'}]`),
        matchedNodes: this.nodes.filter((n) => n.matched).length,
      };
    }

    // ── 渲染 ─────────────────────────────────────────────────────────
    _frame(now) {
      this.frames++;
      const ctx = this.ctx;
      const dt = Math.min(0.05, (now - this.t0) / 1000 || 0.016);
      this.t0 = now;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.W, this.H);

      this.drawBackdrop(ctx);

      for (const e of this.edges) {
        if (e.t < 1) { e.t = Math.min(1, e.t + dt * 2.6); this.animating = true; }
        const flashing = e.flashUntil && e.flashUntil > now;
        if (flashing) this.animating = true;
        // 粒子推进：每 1.6s 走完全程
        e.particles = e.particles.map((p) => (p + dt * 0.62) % 1);
      }
      for (const n of this.nodes) {
        const target = n.matched ? 1 : 0.32;
        n.glow += (target - n.glow) * Math.min(1, dt * 6);
        if (n.flashUntil && n.flashUntil > now) { n.flash = 1; this.animating = true; } else n.flash += (0 - n.flash) * Math.min(1, dt * 4);
        if (n.healUntil && n.healUntil > now) this.animating = true;
      }

      // 先画线再画节点，节点压在线上面，视觉更干净
      for (const e of this.edges) this.drawEdge(ctx, e, now);
      for (const n of this.nodes) this.drawNode(ctx, n, now);

      this.drawColumnLabels(ctx);
      requestAnimationFrame(this._frame);
    }

    drawBackdrop(ctx) {
      const W = this.W, H = this.H;
      ctx.save();
      ctx.strokeStyle = 'rgba(29,39,64,0.55)';
      ctx.lineWidth = 1;
      const step = 26;
      ctx.beginPath();
      for (let x = 0; x < W; x += step) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
      for (let y = 0; y < H; y += step) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
      ctx.stroke();
      ctx.restore();
    }

    drawColumnLabels(ctx) {
      const W = this.W;
      ctx.save();
      ctx.font = '600 10px "Cascadia Mono", Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(132,150,179,0.75)';
      ctx.fillText('系统 A · ProductDTO', W * 0.055 + Math.min(206, W * 0.30) / 2, 15);
      ctx.fillText('系统 B · erp_goods (2009)', W * 0.945 - Math.min(206, W * 0.30) / 2, 15);
      ctx.restore();
    }

    bezier(e, t) {
      const dx = Math.max(40, Math.abs(e.x1 - e.x2) * 0.42);
      const c1x = e.x1 - dx, c1y = e.y1;
      const c2x = e.x2 + dx, c2y = e.y2;
      const u = 1 - t;
      return {
        x: u * u * u * e.x1 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * e.x2,
        y: u * u * u * e.y1 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * e.y2,
      };
    }

    drawEdge(ctx, e, now) {
      const flashing = e.flashUntil && e.flashUntil > now;
      const col = flashing ? '#f87171' : e.color;
      const alpha = 0.12 + 0.62 * e.t;
      const dx = Math.max(40, Math.abs(e.x1 - e.x2) * 0.42);
      const c1x = e.x1 - dx, c2x = e.x2 + dx;
      const endT = e.t;

      ctx.save();
      // 主体曲线（用采样近似部分绘制，实现"生长"动画）
      ctx.beginPath();
      ctx.moveTo(e.x1, e.y1);
      const STEPS = 26;
      for (let i = 1; i <= STEPS; i++) {
        const t = (i / STEPS) * endT;
        const u = 1 - t;
        ctx.lineTo(
          u * u * u * e.x1 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * e.x2,
          u * u * u * e.y1 + 3 * u * u * t * e.y1 + 3 * u * t * t * e.y2 + t * t * t * e.y2,
        );
      }
      ctx.strokeStyle = col;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = flashing ? 2.2 : 1.35;
      ctx.shadowColor = col;
      ctx.shadowBlur = flashing ? 14 : 7;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // 流光粒子
      ctx.globalAlpha = alpha;
      for (const p of e.particles) {
        if (p > endT) continue;
        const pt = this.bezier(e, p);
        const grd = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, 5.2);
        grd.addColorStop(0, flashing ? '#fff' : col);
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grd;
        ctx.beginPath(); ctx.arc(pt.x, pt.y, 5.2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;

      // 算子胶囊
      if (e.t > 0.55 && e.labels.length) {
        const mid = this.bezier(e, 0.5);
        const label = e.labels.join('→');
        ctx.font = '600 9.5px "Cascadia Mono", Consolas, monospace';
        const tw = ctx.measureText(label).width;
        const bw = tw + 12, bh = 15;
        const bx = mid.x - bw / 2, by = mid.y - bh / 2;
        ctx.globalAlpha = Math.min(1, (e.t - 0.55) / 0.25);
        ctx.fillStyle = 'rgba(7,10,17,0.94)';
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        roundRect(ctx, bx, by, bw, bh, 7);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = col;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, mid.x, mid.y + 0.5);
        ctx.globalAlpha = 1;
      }
      // 置信度（低边际时提示"这是猜的"）
      if (e.margin !== null && e.margin !== undefined && e.margin < 0.05 && e.t > 0.9) {
        const mid = this.bezier(e, 0.5);
        ctx.font = '600 9px "Cascadia Mono", monospace';
        ctx.fillStyle = '#fbbf24';
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText('⚠低边际', mid.x, mid.y - 9);
      }
      ctx.restore();
    }

    drawNode(ctx, n, now) {
      const flashing = n.flashUntil && n.flashUntil > now;
      const healing = n.healUntil && n.healUntil > now;
      const accent = flashing ? '#f87171' : healing ? '#34d399' : n.matched ? '#22d3ee' : '#334155';
      const isLeft = n.side === 'L';
      ctx.save();
      ctx.globalAlpha = 0.35 + 0.65 * n.glow;

      // 底
      const g = ctx.createLinearGradient(n.x, n.y, n.x + n.w, n.y + n.h);
      g.addColorStop(0, flashing ? 'rgba(248,113,113,0.20)' : 'rgba(14,20,33,0.98)');
      g.addColorStop(1, flashing ? 'rgba(248,113,113,0.08)' : 'rgba(18,26,43,0.98)');
      ctx.fillStyle = g;
      roundRect(ctx, n.x, n.y, n.w, n.h, 6);
      ctx.fill();

      ctx.strokeStyle = accent;
      ctx.lineWidth = flashing ? 1.8 : 1;
      if (n.matched || flashing) { ctx.shadowColor = accent; ctx.shadowBlur = flashing ? 16 : 8; }
      ctx.stroke();
      ctx.shadowBlur = 0;

      // 字段名
      ctx.textBaseline = 'middle';
      ctx.font = '600 11.5px "Cascadia Mono", Consolas, monospace';
      ctx.fillStyle = n.matched || flashing ? '#e6edf7' : '#7c8aa3';
      const pad = 9;
      if (isLeft) { ctx.textAlign = 'left'; ctx.fillText(clip(ctx, n.name, n.w - 108), n.x + pad, n.y + n.h / 2 + 0.5); }
      else { ctx.textAlign = 'right'; ctx.fillText(clip(ctx, n.name, n.w - 108), n.x + n.w - pad, n.y + n.h / 2 + 0.5); }

      // 右侧元信息（类型/单位）
      const metaTxt = `${n.unit && n.unit !== 'null' ? n.unit : n.type}`;
      ctx.font = '9.5px "Cascadia Mono", Consolas, monospace';
      ctx.fillStyle = n.unit && n.unit !== 'null' ? '#fbbf24' : '#5b6b87';
      if (isLeft) { ctx.textAlign = 'right'; ctx.fillText(metaTxt, n.x + n.w - pad, n.y + n.h / 2 + 0.5); }
      else { ctx.textAlign = 'left'; ctx.fillText(metaTxt, n.x + pad, n.y + n.h / 2 + 0.5); }

      // 概念锚定标记（左侧小竖条）
      ctx.fillStyle = n.concept ? '#a78bfa' : 'rgba(91,107,135,0.5)';
      ctx.fillRect(isLeft ? n.x - 3 : n.x + n.w, n.y + 5, 2.5, n.h - 10);
      ctx.restore();
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function clip(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let s = text;
    while (s.length > 3 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
    return s + '…';
  }

  global.Topo = Topo;
  global.TopoColors = OP_COLOR;
})(window);
