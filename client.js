/**
 * dsh-remotion-launcher —— Client 半部
 *
 * 形态：官方 Client 模块（window.__ModuleLoader__.load + factory）。
 * 在 shell.overlay 里挂一个可拖动的悬浮按钮 + 启动面板：
 *   · 更新横幅（宿主启动时静默查过版本，有新版直接提示）
 *   · 构建前端 / 启动 / 停止 Remotion Studio 服务
 *   · 设置折叠区：工程目录、下载源、端口
 *   · 实时日志与健康状态
 *
 * 只用 react 与 DSH 的 slots 服务，不依赖任何 ui-primitives，
 * 这样 DSH 升级时不容易被组件契约变化波及。
 */
window.__ModuleLoader__.load({
  id: 'dsh-remotion-launcher',

  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    const API = '/remotion-plugin';
    const POLL_MS = 1200;
    const BTN = 42;
    const POS_KEY = 'dsh-remotion-launcher.pos';
    const PANEL_POS_KEY = 'dsh-remotion-launcher.panelPos';
    const DRAG_THRESHOLD = 4;
    /** apply() 里存下来的 client Context，用来调 DSH 的目录选择器 */
    let clientCtx = null;

    const REGISTRY_MIRROR = 'https://registry.npmmirror.com';
    const REGISTRY_NPM = 'https://registry.npmjs.org';
    const REGISTRY_CHOICES = [
      { value: REGISTRY_MIRROR, label: '国内镜像 npmmirror' },
      { value: REGISTRY_NPM, label: 'npm 官方' },
      { value: 'custom', label: '自定义…' },
    ];

    /** 安装方式的中文名：决定「一键更新」还是「手动卸载重装」 */
    const KIND_LABEL = {
      npm: 'npm 安装',
      git: 'Git / GitHub 安装',
      link: '本地链接（link:）',
      local: '本地目录（file:）',
      tarball: '本地 / 远程 tarball',
      unknown: '来源未知',
    };

    const C = {
      bg: 'rgba(20, 23, 30, 0.97)',
      card: 'rgba(255,255,255,0.035)',
      cardUp: 'rgba(255,255,255,0.062)',
      border: 'rgba(255,255,255,0.095)',
      borderSoft: 'rgba(255,255,255,0.062)',
      text: '#e9ecf3',
      dim: '#98a0b0',
      faint: '#6d7585',
      ok: '#4ade80',
      warn: '#fbbf24',
      bad: '#f87171',
      accent: '#7aa6f8',
      ico: '#bfd2f4',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    };

    const S = {
      fab: {
        position: 'fixed', zIndex: 2147483000,
        width: BTN, height: BTN, borderRadius: 10,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(32, 35, 44, 0.42)',
        border: 'none', padding: 0,
        boxShadow: '0 2px 8px rgba(0,0,0,0.22)',
        fontSize: 20, lineHeight: 1,
        cursor: 'grab', touchAction: 'none', userSelect: 'none',
        transition: 'background 140ms ease, transform 140ms cubic-bezier(.2,.8,.3,1)',
        outline: 'none',
        WebkitBackdropFilter: 'blur(4px)', backdropFilter: 'blur(4px)',
      },
      fabHover: { background: 'rgba(52, 58, 74, 0.88)' },
      fabDragging: {
        transform: 'scale(1.08)',
        background: 'rgba(52, 58, 74, 0.95)',
        cursor: 'grabbing',
      },
      fabOpen: { background: 'rgba(58, 66, 86, 0.95)' },
      badge: {
        position: 'absolute', top: 5, right: 5,
        width: 8, height: 8, borderRadius: 4,
        background: C.warn,
        boxShadow: `0 0 0 2px rgba(20,23,30,0.85), 0 0 8px ${C.warn}`,
      },
      panel: {
        position: 'fixed', zIndex: 2147483000,
        display: 'flex', flexDirection: 'column',
        background: C.bg, color: C.text,
        border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden',
        boxShadow: '0 24px 64px rgba(0,0,0,0.62), inset 0 1px 0 rgba(255,255,255,0.05)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
        fontSize: 13,
      },
      head: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        padding: '9px 10px 9px 12px',
        borderBottom: `1px solid ${C.borderSoft}`,
        background: 'rgba(255,255,255,0.022)',
      },
      titleWrap: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
      title: { fontWeight: 600, fontSize: 12.8, letterSpacing: 0.2, color: C.text, whiteSpace: 'nowrap' },
      verChip: {
        fontFamily: C.mono, fontSize: 10.2, color: C.dim,
        padding: '1px 5px', borderRadius: 5,
        background: 'rgba(255,255,255,0.06)', border: `1px solid ${C.borderSoft}`,
        whiteSpace: 'nowrap',
      },
      headActions: { display: 'flex', alignItems: 'center', gap: 2, flex: '0 0 auto' },
      iconBtn: {
        background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer',
        width: 26, height: 24, borderRadius: 7, padding: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 14, lineHeight: 1,
        transition: 'background 120ms ease, color 120ms ease',
      },
      body: {
        padding: 10, display: 'flex', flexDirection: 'column', gap: 9,
        /* 面板被 60% 高度卡住时，超出部分在这里滚动；minHeight:0 让它能真正被压缩 */
        flex: '1 1 auto', minHeight: 0,
        overflowY: 'auto', overflowX: 'hidden',
      },

      banner: {
        display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto',
        padding: '8px 9px', borderRadius: 10,
        border: '1px solid', fontSize: 12,
      },
      bannerText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 auto' },
      bannerTitle: { fontWeight: 600, fontSize: 12.2, lineHeight: 1.35 },
      bannerDetail: { fontSize: 10.8, lineHeight: 1.4, color: C.dim },

      hero: {
        display: 'flex', flexDirection: 'column', gap: 8, flex: '0 0 auto',
        padding: '10px 11px 11px', borderRadius: 12,
        border: `1px solid ${C.borderSoft}`,
        background: 'linear-gradient(180deg, rgba(255,255,255,0.052), rgba(255,255,255,0.022))',
      },
      heroTop: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
      heroStatus: { fontSize: 13.5, fontWeight: 600, color: C.text, whiteSpace: 'nowrap' },
      portChip: {
        marginLeft: 'auto', fontFamily: C.mono, fontSize: 10.8, color: C.dim,
        padding: '1px 6px', borderRadius: 6,
        background: 'rgba(0,0,0,0.28)', border: `1px solid ${C.borderSoft}`,
      },
      urlRow: {
        display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
        padding: '4px 7px', borderRadius: 8,
        background: 'rgba(0,0,0,0.26)', border: `1px solid ${C.borderSoft}`,
      },
      urlText: {
        flex: '1 1 auto', minWidth: 0, fontFamily: C.mono, fontSize: 11.4, color: C.ico,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      urlEmpty: { color: C.faint },

      meta: { display: 'flex', gap: 8, flex: '0 0 auto' },
      metaCell: {
        flex: '1 1 0', minWidth: 0,
        display: 'flex', flexDirection: 'column', gap: 2,
        padding: '7px 9px', borderRadius: 10,
        border: `1px solid ${C.borderSoft}`, background: C.card,
      },
      metaLabel: { fontSize: 10.4, color: C.faint, letterSpacing: 0.2 },
      metaValue: {
        fontSize: 12, color: C.text, fontFamily: C.mono,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },

      /* MCP 配置卡：一行装下「标题 + 接法切换 + 复制」 */
      mcpHead: {
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '7px 9px 7px 10px', minWidth: 0, flex: '0 0 auto',
      },
      mcpTitle: {
        display: 'flex', alignItems: 'center', gap: 5, flex: '1 1 auto', minWidth: 0,
        border: 'none', background: 'transparent', color: C.text,
        cursor: 'pointer', padding: 0, fontSize: 12.2, fontWeight: 600,
        textAlign: 'left', whiteSpace: 'nowrap',
      },
      seg: {
        display: 'flex', gap: 2, padding: 2, flex: '0 0 auto',
        borderRadius: 7, background: 'rgba(0,0,0,0.30)', border: `1px solid ${C.borderSoft}`,
      },
      segBtn: {
        border: 'none', background: 'transparent', color: C.dim,
        fontSize: 10.2, lineHeight: 1.2, padding: '2px 6px', borderRadius: 5,
        cursor: 'pointer', fontFamily: C.mono,
        transition: 'background 100ms ease, color 100ms ease',
      },
      segBtnActive: { background: 'rgba(110,168,254,0.22)', color: '#d5e4ff' },
      mcpBody: {
        display: 'flex', flexDirection: 'column', gap: 6, flex: '0 0 auto',
        padding: '8px 10px 10px', borderTop: `1px solid ${C.borderSoft}`,
      },
      mcpPre: {
        margin: 0, maxHeight: 152, overflowY: 'auto', overflowX: 'hidden',
        padding: '7px 8px', borderRadius: 8,
        background: 'rgba(0,0,0,0.34)', border: `1px solid ${C.borderSoft}`,
        fontFamily: C.mono, fontSize: 10.4, lineHeight: 1.55,
        /* 工程路径很长，宁可折行也别横向切掉 —— 反正主要动作用「复制」 */
        color: C.ico, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      },
      mcpErr: { color: C.bad, fontSize: 10.6, lineHeight: 1.5, flex: '0 0 auto' },

      section: {
        flex: '0 0 auto',
        borderRadius: 11, border: `1px solid ${C.borderSoft}`,
        background: C.card, overflow: 'hidden',
      },
      sectionHead: {
        display: 'flex', alignItems: 'center', gap: 7, width: '100%',
        padding: '8px 10px', border: 'none', background: 'transparent',
        color: C.text, cursor: 'pointer', fontSize: 12.2, textAlign: 'left',
        transition: 'background 120ms ease',
      },
      sectionTitle: { fontWeight: 600, flex: '1 1 auto' },
      caret: { color: C.faint, fontSize: 9, lineHeight: 1 },
      sectionBody: {
        display: 'flex', flexDirection: 'column', gap: 8,
        padding: '0 10px 10px', borderTop: `1px solid ${C.borderSoft}`,
        paddingTop: 9,
      },

      row: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, minWidth: 0 },
      label: { color: C.dim, minWidth: 42, flex: '0 0 auto', fontSize: 11.4 },
      value: { color: C.text, fontSize: 11.8, wordBreak: 'break-all', fontFamily: C.mono },
      ellipsis: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },

      input: {
        flex: '1 1 auto', minWidth: 0, padding: '4px 7px', borderRadius: 7,
        border: `1px solid ${C.border}`, background: 'rgba(0,0,0,0.28)',
        color: C.text, fontSize: 11.8, fontFamily: C.mono, outline: 'none',
      },

      actions: { display: 'flex', gap: 7, flexWrap: 'nowrap' },
      btn: {
        flex: '1 1 0', minWidth: 0, padding: '8px 9px', borderRadius: 9,
        border: `1px solid ${C.border}`, background: 'rgba(255,255,255,0.055)', color: C.text,
        cursor: 'pointer', fontSize: 12.2, fontWeight: 500,
        transition: 'background 120ms ease, border-color 120ms ease, transform 90ms ease, opacity 120ms ease',
      },
      btnPrimary: {
        flex: '1 1 0', minWidth: 0, padding: '8px 9px', borderRadius: 9,
        border: '1px solid rgba(120, 165, 250, 0.55)',
        background: 'linear-gradient(160deg, rgba(78, 116, 190, 0.62), rgba(52, 78, 132, 0.62))',
        color: '#e9f0ff', cursor: 'pointer', fontSize: 12.2, fontWeight: 600,
        transition: 'background 120ms ease, border-color 120ms ease, transform 90ms ease, opacity 120ms ease',
      },
      btnDanger: {
        flex: '1 1 0', minWidth: 0, padding: '8px 9px', borderRadius: 9,
        border: '1px solid rgba(248, 113, 113, 0.45)',
        background: 'rgba(248, 113, 113, 0.12)',
        color: '#ffc9c9', cursor: 'pointer', fontSize: 12.2, fontWeight: 500,
        transition: 'background 120ms ease, border-color 120ms ease, transform 90ms ease, opacity 120ms ease',
      },
      mini: {
        flex: '0 0 auto', padding: '4px 8px', borderRadius: 7,
        border: `1px solid ${C.border}`, background: 'rgba(255,255,255,0.055)', color: C.text,
        cursor: 'pointer', fontSize: 11.2,
        transition: 'background 120ms ease, border-color 120ms ease, opacity 120ms ease',
      },

      selectBtn: {
        flex: '1 1 auto', minWidth: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        padding: '4px 8px', borderRadius: 7,
        border: `1px solid ${C.border}`, background: 'rgba(0,0,0,0.28)',
        color: C.text, fontSize: 11.8, cursor: 'pointer',
        transition: 'background 120ms ease, border-color 120ms ease',
      },
      selectDisabled: { opacity: 0.45, cursor: 'not-allowed' },
      selectArrow: { color: C.dim, fontSize: 9, lineHeight: 1 },
      selectMenu: {
        display: 'flex', flexDirection: 'column', gap: 2,
        padding: 3, borderRadius: 8,
        background: 'rgba(0,0,0,0.34)', border: `1px solid ${C.border}`,
      },
      selectItem: {
        textAlign: 'left', padding: '5px 8px', borderRadius: 6,
        border: 'none', background: 'transparent', color: C.text,
        fontSize: 11.8, cursor: 'pointer',
        transition: 'background 100ms ease',
      },
      selectItemActive: { background: 'rgba(110,168,254,0.20)', color: '#d5e4ff' },

      logsHead: {
        display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto',
        padding: '2px 2px 0',
      },
      logsTitle: { fontSize: 10.6, color: C.faint, letterSpacing: 0.4, textTransform: 'uppercase' },
      logBox: {
        /* 面板被视口卡住时优先压日志区，而不是把内容顶到屏幕外 */
        height: 150, minHeight: 76, flex: '1 1 auto', overflow: 'auto', background: 'rgba(0,0,0,0.30)',
        border: `1px solid ${C.borderSoft}`, borderRadius: 9, padding: '7px 9px',
        fontFamily: C.mono, fontSize: 11, lineHeight: 1.55,
      },
      logLine: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      hint: { color: C.faint, fontSize: 10.8, lineHeight: 1.5, flex: '0 0 auto' },
      err: { color: C.bad, fontSize: 11.4, lineHeight: 1.5, flex: '0 0 auto' },
      pre: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: C.mono, fontSize: 10.6, lineHeight: 1.55, color: C.ico },
    };

    const BUILD_TEXT = { idle: '未构建', running: '构建中', success: '构建成功', failed: '构建失败' };
    const SERVER_TEXT = {
      idle: '未启动', starting: '启动中', running: '运行中',
      external: '外部服务在跑', stopping: '停止中', stopped: '已停止', failed: '启动失败',
    };

    /* ── 位置 ─────────────────────────────────────────────────── */

    function clampPos(point) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      return {
        x: Math.min(Math.max(8, Math.round(point.x)), Math.max(8, vw - BTN - 8)),
        y: Math.min(Math.max(8, Math.round(point.y)), Math.max(8, vh - BTN - 8)),
      };
    }

    /**
     * 面板自己的位置：只保证整块留在视口里，不跟随按钮。
     *
     * `height` 是面板实测高度。给了就按「整块不能超出视口底部」来限制 ——
     * 这样拖到底不会先冲出去再被弹回来，拖完停在哪儿就是哪儿。
     */
    function clampPanelPos(point, height) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.min(400, vw - 24);
      const maxY = height > 0 ? Math.max(8, vh - 12 - height) : Math.max(8, vh - 120);
      return {
        x: Math.min(Math.max(8, Math.round(point.x)), Math.max(8, vw - w - 8)),
        y: Math.min(Math.max(8, Math.round(point.y)), maxY),
      };
    }

    function loadPanelPos() {
      try {
        const raw = JSON.parse(window.localStorage.getItem(PANEL_POS_KEY) || 'null');
        if (raw && Number.isFinite(raw.x) && Number.isFinite(raw.y)) return clampPanelPos(raw);
      } catch { /* ignore */ }
      return null;
    }

    function defaultPos() {
      return clampPos({ x: window.innerWidth - BTN - 18, y: window.innerHeight - BTN - 96 });
    }

    function loadCachedPos() {
      try {
        const raw = JSON.parse(window.localStorage.getItem(POS_KEY) || 'null');
        if (raw && Number.isFinite(raw.x) && Number.isFinite(raw.y)) return clampPos(raw);
      } catch { /* ignore */ }
      return defaultPos();
    }

    function cachePos(point) {
      try { window.localStorage.setItem(POS_KEY, JSON.stringify({ x: point.x, y: point.y })); } catch { /* ignore */ }
    }

    /**
     * 复制文本。
     *
     * 两步走：先用 clipboard API；它不可用、被拒、或者迟迟不 settle（没用户手势时
     * 某些浏览器会把 Promise 一直挂着）就退回 execCommand —— 复制配置这种
     * 「一次不行就白点」的操作，不能让按钮点了没反应。
     */
    function legacyCopy(text) {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        return ok;
      } catch {
        return false;
      }
    }

    async function copyText(text) {
      if (!navigator.clipboard || !navigator.clipboard.writeText) return legacyCopy(text);
      // 两个分支都接住，免得超时之后它才拒绝，冒出未处理的 Promise 异常
      const modern = navigator.clipboard.writeText(text).then(() => true, () => false);
      const winner = await Promise.race([
        modern,
        new Promise((resolve) => { setTimeout(() => resolve('pending'), 800); }),
      ]);
      return winner === true ? true : legacyCopy(text);
    }

    /**
     * 面板内部滚动区的滚动条。
     *
     * 面板高度只占视口 60%，内容多了就在面板里滚；系统默认滚动条是亮色的，
     * 压在深色面板上很扎眼。样式用属性选择器限定在 `[data-rsl-scroll]` 上，
     * 不碰宿主页面的任何东西。
     */
    const SCROLL_STYLE_ID = 'dsh-remotion-launcher-style';

    function ensureScrollStyles() {
      if (typeof document === 'undefined' || !document.head) return;
      if (document.getElementById(SCROLL_STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = SCROLL_STYLE_ID;
      style.textContent = [
        '[data-rsl-scroll]{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,0.18) transparent}',
        '[data-rsl-scroll]::-webkit-scrollbar{width:8px;height:8px}',
        '[data-rsl-scroll]::-webkit-scrollbar-track{background:transparent}',
        '[data-rsl-scroll]::-webkit-scrollbar-thumb{',
        '  background:rgba(255,255,255,0.16);border-radius:99px;',
        '  border:2px solid transparent;background-clip:padding-box}',
        '[data-rsl-scroll]::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.30);background-clip:padding-box}',
        '[data-rsl-scroll]::-webkit-scrollbar-corner{background:transparent}',
      ].join('');
      document.head.appendChild(style);
    }

    /** 「MCP 配置」用哪种接法：记在本机，下次打开还是这个 */
    const MCP_MODE_KEY = 'remotion-launcher-mcp-mode';

    function loadMcpMode() {
      try {
        return window.localStorage.getItem(MCP_MODE_KEY) === 'http' ? 'http' : 'stdio';
      } catch {
        return 'stdio';
      }
    }

    /* ── 小组件 ───────────────────────────────────────────────── */

    function dot(color, size) {
      const diameter = size || 7;
      return h('span', {
        style: {
          width: diameter, height: diameter, borderRadius: diameter,
          background: color, display: 'inline-block', flex: '0 0 auto',
          boxShadow: color === C.faint || color === C.dim ? 'none' : `0 0 8px ${color}`,
        },
      });
    }

    function tone(value) {
      if (value === 'success' || value === 'running' || value === 'ok') return C.ok;
      if (value === 'starting' || value === 'warn') return C.warn;
      if (value === 'failed' || value === 'bad') return C.bad;
      return C.dim;
    }

    function timeText(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    const BUTTON_VARIANTS = {
      default: {
        base: S.btn,
        hover: { background: 'rgba(255,255,255,0.12)', borderColor: 'rgba(255,255,255,0.22)' },
      },
      primary: {
        base: S.btnPrimary,
        hover: {
          background: 'linear-gradient(160deg, rgba(96, 138, 214, 0.82), rgba(64, 94, 156, 0.82))',
          borderColor: 'rgba(150, 190, 255, 0.75)',
        },
      },
      danger: {
        base: S.btnDanger,
        hover: {
          background: 'rgba(248, 113, 113, 0.24)',
          borderColor: 'rgba(248, 113, 113, 0.72)',
        },
      },
      mini: {
        base: S.mini,
        hover: { background: 'rgba(255,255,255,0.13)', borderColor: 'rgba(255,255,255,0.24)' },
      },
    };

    function ActButton({ children, onClick, disabled, variant, title, style }) {
      const [hover, setHover] = React.useState(false);
      const [pressed, setPressed] = React.useState(false);
      const v = BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.default;
      const merged = {
        ...v.base,
        ...(style || {}),
        ...(hover && !disabled ? v.hover : {}),
        ...(pressed && !disabled ? { transform: 'scale(0.975)' } : {}),
        ...(disabled ? { opacity: 0.42, cursor: 'not-allowed', filter: 'saturate(0.6)' } : {}),
      };
      return h('button', {
        type: 'button',
        style: merged,
        disabled: Boolean(disabled),
        title,
        onClick,
        onPointerEnter: () => setHover(true),
        onPointerLeave: () => { setHover(false); setPressed(false); },
        onPointerDown: () => { if (!disabled) setPressed(true); },
        onPointerUp: () => setPressed(false),
      }, children);
    }

    function IconButton({ children, onClick, title, active }) {
      const [hover, setHover] = React.useState(false);
      return h('button', {
        type: 'button',
        title,
        'aria-label': title,
        style: {
          ...S.iconBtn,
          ...(hover || active ? { background: 'rgba(255,255,255,0.10)', color: C.text } : {}),
        },
        onClick,
        onPointerEnter: () => setHover(true),
        onPointerLeave: () => setHover(false),
      }, children);
    }

    /** 折叠区标题：inline 样式没有 :hover，自己管一下 */
    function SectionHead({ open, label, badge, onClick }) {
      const [hover, setHover] = React.useState(false);
      return h('button', {
        type: 'button',
        style: { ...S.sectionHead, ...(hover ? { background: 'rgba(255,255,255,0.05)' } : {}) },
        onClick,
        onPointerEnter: () => setHover(true),
        onPointerLeave: () => setHover(false),
        'aria-expanded': Boolean(open),
      }, [
        h('span', { key: 't', style: S.sectionTitle }, label),
        badge ? h('span', { key: 'b', style: { fontSize: 10.8, color: C.faint } }, badge) : null,
        h('span', { key: 'c', style: S.caret }, open ? '▴' : '▾'),
      ]);
    }

    function LauncherOverlay() {
      const [open, setOpen] = React.useState(false);
      const [pos, setPos] = React.useState(loadCachedPos);
      const [dragging, setDragging] = React.useState(false);
      const [hovering, setHovering] = React.useState(false);
      const [data, setData] = React.useState(null);
      const [logs, setLogs] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [portDraft, setPortDraft] = React.useState('');
      /** 「停止中」卡住超过 6 秒就亮出强制重置 */
      const [stopStuck, setStopStuck] = React.useState(false);
      /** 下载项目：目标目录 / 下载源 */
      const [installDir, setInstallDir] = React.useState('');
      const [registryChoice, setRegistryChoice] = React.useState(REGISTRY_MIRROR);
      const [customRegistry, setCustomRegistry] = React.useState('');
      const [picking, setPicking] = React.useState(false);
      /** 「设置与安装」折叠区（没工程时自动展开） */
      const [showSettings, setShowSettings] = React.useState(false);
      /** 折叠区里的「安装 / 更换工程」卡片 */
      const [showInstall, setShowInstall] = React.useState(false);
      const installAutoShownRef = React.useRef(false);
      /** 已经处理过的「安装成功」时间戳，避免同一结果把卡片反复关掉 */
      const installDoneRef = React.useRef(null);
      /** 更新区 / 检查结果 */
      const [showUpdate, setShowUpdate] = React.useState(false);
      const [checking, setChecking] = React.useState(false);
      const [pluginMsg, setPluginMsg] = React.useState(null);
      /** 更新会短暂卸掉面板，点一次不够，再点一次才真更新 */
      const [confirmUpdate, setConfirmUpdate] = React.useState(false);
      /** 日志「清空」：只清本地视图，不动 host 的环形缓冲 */
      const [clearedSeq, setClearedSeq] = React.useState(0);
      const [copied, setCopied] = React.useState(false);
      /** MCP 配置：stdio / http 两种接法 + 复制按钮 */
      const [mcpMode, setMcpMode] = React.useState(loadMcpMode);
      const [mcpOpen, setMcpOpen] = React.useState(false);
      const [mcpCopied, setMcpCopied] = React.useState(false);
      /** 复制被浏览器挡住时，卡片里直接说清楚（别用全局 error，它会被轮询清掉） */
      const [mcpFailed, setMcpFailed] = React.useState(false);
      /** 下载源用自绘下拉（原生 select 的选项列表跟深色面板冲突，字看不清） */
      const [registryMenuOpen, setRegistryMenuOpen] = React.useState(false);
      const [hoverReg, setHoverReg] = React.useState(null);
      /** 面板自身位置（可拖标题栏移动）；null = 还没定过，按按钮位置算 */
      const [panelPos, setPanelPos] = React.useState(loadPanelPos);
      const [panelDragging, setPanelDragging] = React.useState(false);
      /** 面板实测高度：内容比视口高时整块往上让位，别把日志切成半截 */
      const [panelH, setPanelH] = React.useState(0);

      const seqRef = React.useRef(0);
      const logsRef = React.useRef([]);
      const boxRef = React.useRef(null);
      const pullRef = React.useRef(() => {});
      const dragRef = React.useRef(null);
      const movedRef = React.useRef(false);
      const posSyncedRef = React.useRef(false);
      const portSyncedRef = React.useRef(false);
      const registrySyncedRef = React.useRef(false);
      const panelDragRef = React.useRef(null);
      const panelPosRef = React.useRef(panelPos);
      const panelElRef = React.useRef(null);
      const panelSyncedRef = React.useRef(false);
      const confirmTimerRef = React.useRef(null);
      panelPosRef.current = panelPos;

      /**
       * 量面板实际高度。
       *
       * 面板是「内容多高就多高」，但视口装不下时得知道到底超了多少 ——
       * 有了实测高度，就能把整块往上挪，让展开的「版本与更新」和日志都露出来，
       * 而不是在底部硬切一刀。
       *
       * 刻意做成「每次渲染后都量」：展开折叠区、日志变多、MCP JSON 展开这些
       * 高度变化都是渲染驱动的，只在打开时量一次会漏掉后面的增长（面板就会
       * 顶到屏幕外）。setPanelH 带等值判断，量到同样的高度不会再触发渲染。
       */
      React.useEffect(() => {
        if (!open) {
          setPanelH(0);
          return;
        }
        const el = panelElRef.current;
        if (!el) return;
        const next = Math.round(el.getBoundingClientRect().height);
        setPanelH((prev) => (prev === next ? prev : next));
      });

      /** 不经过 React 的尺寸变化（字体加载之类）由 ResizeObserver 兜住 */
      React.useEffect(() => {
        if (!open || typeof ResizeObserver === 'undefined') return;
        const el = panelElRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => {
          const next = Math.round(el.getBoundingClientRect().height);
          setPanelH((prev) => (prev === next ? prev : next));
        });
        ro.observe(el);
        return () => ro.disconnect();
      }, [open]);

      /* 数据轮询；首次拿到 Host 侧位置后，覆盖本地缓存 */
      React.useEffect(() => {
        let cancelled = false;
        let timer;

        const pull = async () => {
          try {
            const res = await fetch(`${API}/state?since=${seqRef.current}`, { cache: 'no-store' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const body = await res.json();
            if (cancelled) return;

            if (!posSyncedRef.current && body.fabPos
              && Number.isFinite(body.fabPos.x) && Number.isFinite(body.fabPos.y)) {
              posSyncedRef.current = true;
              setPos(clampPos(body.fabPos));
            }

            if (!portSyncedRef.current && Number.isInteger(body.port)) {
              portSyncedRef.current = true;
              setPortDraft(String(body.port));
            }

            // 下载源以 host 为准：换浏览器 / 重启之后还是同一个
            if (!registrySyncedRef.current && typeof body.registry === 'string' && body.registry) {
              registrySyncedRef.current = true;
              if (body.registry === REGISTRY_MIRROR || body.registry === REGISTRY_NPM) {
                setRegistryChoice(body.registry);
              } else {
                setRegistryChoice('custom');
                setCustomRegistry(body.registry);
              }
            }

            if (!panelSyncedRef.current && body.panelPos
              && Number.isFinite(body.panelPos.x) && Number.isFinite(body.panelPos.y)) {
              panelSyncedRef.current = true;
              const next = clampPanelPos(body.panelPos);
              panelPosRef.current = next;
              setPanelPos(next);
            }

            if (Array.isArray(body.logs) && body.logs.length > 0) {
              // 按 seq 去重：慢响应/重连时 host 可能把已经收到的日志再发一遍
              const fresh = [];
              for (const entry of body.logs) {
                const seq = Number(entry && entry.seq) || 0;
                if (seq <= seqRef.current) continue;
                seqRef.current = seq;
                fresh.push(entry);
              }
              if (fresh.length > 0) {
                logsRef.current = logsRef.current.concat(fresh).slice(-500);
                setLogs(logsRef.current.slice());
              }
            }
            setData(body);
            setError(null);
          } catch (e) {
            if (!cancelled) setError(e && e.message ? e.message : String(e));
          }
          if (!cancelled) timer = setTimeout(pull, POLL_MS);
        };

        pullRef.current = pull;
        pull();
        return () => { cancelled = true; if (timer) clearTimeout(timer); };
      }, []);

      const serverStatus = (data && data.server && data.server.status) || 'idle';
      React.useEffect(() => {
        if (serverStatus !== 'stopping') {
          setStopStuck(false);
          return;
        }
        const timer = setTimeout(() => setStopStuck(true), 6000);
        return () => clearTimeout(timer);
      }, [serverStatus]);

      React.useEffect(() => {
        if (!data) return;
        // 第一次拿到状态：没工程就自动把设置区展开、安装卡片亮出来
        if (!installAutoShownRef.current) {
          installAutoShownRef.current = true;
          if (!data.projectValid) {
            setShowSettings(true);
            setShowInstall(true);
          }
        }
        // 安装成功后收起卡片，目录清空（下次换工程重新选）。
        // 注意：host 那边 install.status 成功后会一直停在 success，所以必须用
        // finishedAt 去重 —— 否则用户之后每次点「更换」，卡片都会被这里立刻关掉
        //（表现就是「一闪而过，一直打不开」）。
        const done = data.install;
        if (showInstall && done && done.status === 'success' && done.finishedAt
          && done.finishedAt !== installDoneRef.current) {
          installDoneRef.current = done.finishedAt;
          setShowInstall(false);
          setInstallDir('');
        }
      }, [data, showInstall]);

      React.useEffect(() => {
        if (!showInstall) setRegistryMenuOpen(false);
      }, [showInstall]);

      React.useEffect(() => {
        const onResize = () => {
          setPos((prev) => clampPos(prev));
          setPanelPos((prev) => (prev ? clampPanelPos(prev) : prev));
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);

      React.useEffect(() => {
        const box = boxRef.current;
        if (box) box.scrollTop = box.scrollHeight;
      }, [logs.length, open]);

      React.useEffect(() => () => { if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current); }, []);

      const act = React.useCallback(async (path, label) => {
        setBusy(true);
        try {
          const res = await fetch(`${API}${path}`, { method: 'POST' });
          if (!res.ok) throw new Error(`${label}失败（HTTP ${res.status}）`);
          await pullRef.current();
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      }, []);

      /* 改运行端口：先校验，再交给 Host 落盘；服务在跑时 Host 会拒绝 */
      const applyPort = React.useCallback(async () => {
        const next = Number(portDraft);
        if (!Number.isInteger(next) || next < 1024 || next > 65535) {
          setError('端口必须是 1024–65535 之间的整数');
          return;
        }
        try {
          const res = await fetch(`${API}/port`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ port: next }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          setError(null);
          await pullRef.current();
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        }
      }, [portDraft]);

      /* 拖动 */
      const onPointerDown = (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          origin: pos,
        };
        movedRef.current = false;
        setDragging(true);
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      };

      const onPointerMove = (event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!movedRef.current && Math.abs(dx) <= DRAG_THRESHOLD && Math.abs(dy) <= DRAG_THRESHOLD) return;
        movedRef.current = true;
        setPos(clampPos({ x: drag.origin.x + dx, y: drag.origin.y + dy }));
      };

      const finishDrag = (event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        dragRef.current = null;
        setDragging(false);
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* ignore */ }

        if (!movedRef.current) {
          setOpen((value) => !value);
          return;
        }

        posSyncedRef.current = true;
        cachePos(pos);
        fetch(`${API}/pos`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ x: pos.x, y: pos.y }),
        }).catch(() => { /* Host 暂不可达时保留本地缓存 */ });
      };

      const onKeyDown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          setOpen((value) => !value);
        }
      };

      /* ── 下载项目：工程仓库单独发布，用 npm 拉下来 ── */

      const effectiveRegistry = registryChoice === 'custom'
        ? customRegistry.trim()
        : registryChoice;

      const chooseInstallDir = async () => {
        setPicking(true);
        setError(null);
        try {
          let picked = null;

          // ① 先试 DSH 自带的目录选择器（remote.directoryPicker）
          try {
            const picker = clientCtx && clientCtx.remote && clientCtx.remote.directoryPicker;
            if (picker && typeof picker.pick === 'function') {
              const result = await picker.pick();
              if (result && result.ok && typeof result.value === 'string' && result.value) {
                picked = result.value;
              }
            }
          } catch {
            /* 没有 picker / 能力不匹配，走下面的兜底 */
          }

          // ② 兜底：让 host 直接弹系统文件夹选择框
          if (!picked) {
            const res = await fetch(`${API}/pick-dir`, { method: 'POST' });
            const body = await res.json().catch(() => ({}));
            if (body && typeof body.dir === 'string' && body.dir) picked = body.dir;
          }

          if (picked) {
            setInstallDir(picked);
            setError(null);
          } else {
            setError('没有选到目录（可以直接把路径粘贴到输入框）');
          }
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setPicking(false);
        }
      };

      const startInstall = async () => {
        const dir = installDir.trim();
        if (!dir) { setError('请先选择下载目录'); return; }
        if (!/^https?:\/\//i.test(effectiveRegistry)) { setError('下载源要是 http(s) 地址'); return; }
        setBusy(true);
        setError(null);
        try {
          const res = await fetch(`${API}/install-project`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dir, registry: effectiveRegistry }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          await pullRef.current();
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      };

      /** 直接用本机已有的工程目录：不下载，只校验 + 记住 */
      const useExistingProject = async () => {
        const dir = installDir.trim();
        if (!dir) { setError('请先选择工程目录'); return; }
        setBusy(true);
        setError(null);
        try {
          const res = await fetch(`${API}/use-project`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dir }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          setShowInstall(false);
          setInstallDir('');
          await pullRef.current();
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      };

      /* ── 检查更新 ── */

      /** host 侧拿它自己的下载源查两个包；查完刷 state 就行 */
      const checkUpdates = React.useCallback(async () => {
        setChecking(true);
        setError(null);
        try {
          const res = await fetch(`${API}/updates`, { cache: 'no-store' });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          await pullRef.current();
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setChecking(false);
        }
      }, []);

      /** 换下载源：交给 host 落盘，并用新源立刻重查一次 */
      const applyRegistry = React.useCallback(async (next) => {
        if (!/^https?:\/\//i.test(next)) { setError('下载源要是 http(s) 地址'); return; }
        try {
          const res = await fetch(`${API}/registry`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ registry: next }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          setError(null);
          await pullRef.current();
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        }
      }, []);

      /**
       * 一键更新启动器。
       *
       * host 那边会先 remove 再 install（HMR 生效时面板会被短暂卸掉，
       * 新版装好后自己回来），所以这里只负责把请求发出去。
       */
      const runPluginUpdate = async () => {
        if (!confirmUpdate) {
          setConfirmUpdate(true);
          if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
          confirmTimerRef.current = setTimeout(() => setConfirmUpdate(false), 5000);
          return;
        }
        setConfirmUpdate(false);
        setPluginMsg(null);
        try {
          const res = await fetch(`${API}/plugin-update`, { method: 'POST' });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          await pullRef.current();
        } catch (e) {
          setPluginMsg(`更新失败：${e && e.message ? e.message : String(e)}`);
        }
      };

      /** 把「更新完成 / 失败」这条横幅划掉 */
      const ackPluginUpdate = async () => {
        try {
          await fetch(`${API}/plugin-update/ack`, { method: 'POST' });
          await pullRef.current();
        } catch { /* 下次轮询还会带上，忽略 */ }
      };

      /** 工程更新：走 host 的原地更新（保留 data/public/out） */
      const runProjectUpdate = async () => {
        setBusy(true);
        setError(null);
        try {
          const res = await fetch(`${API}/update-project`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ registry: effectiveRegistry }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          await pullRef.current();
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      };

      /* 拖动标题栏：面板自己走，和悬浮按钮各管各的位置 */
      const onPanelHeadDown = (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        if (event.target instanceof Element && event.target.closest('button')) return;
        /**
         * 起点取「屏幕上真实的位置」，不是存下来的位置。
         *
         * 面板装不下时会被整体顶上去（fittedTop < 存档 y），如果这里用存档值，
         * 一按下就会先跳回回弹前的位置，然后才跟着鼠标走。
         */
        const rect = panelElRef.current ? panelElRef.current.getBoundingClientRect() : null;
        const origin = rect
          ? { x: Math.round(rect.left), y: Math.round(rect.top) }
          : (panelPosRef.current || { x: 0, y: 0 });
        if (!panelPosRef.current || panelPosRef.current.x !== origin.x || panelPosRef.current.y !== origin.y) {
          panelPosRef.current = origin;
          setPanelPos(origin);
        }
        panelDragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          origin,
        };
        setPanelDragging(true);
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      };

      const onPanelHeadMove = (event) => {
        const drag = panelDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const next = clampPanelPos({
          x: drag.origin.x + (event.clientX - drag.startX),
          y: drag.origin.y + (event.clientY - drag.startY),
        }, panelH);
        panelPosRef.current = next;
        setPanelPos(next);
      };

      const onPanelHeadUp = (event) => {
        const drag = panelDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        panelDragRef.current = null;
        setPanelDragging(false);
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
        // 落手时按真实高度再收一次，存的就是看得见的位置（重开面板不会跳）
        const settled = clampPanelPos(panelPosRef.current || drag.origin, panelH);
        panelPosRef.current = settled;
        setPanelPos(settled);
        try {
          window.localStorage.setItem(PANEL_POS_KEY, JSON.stringify(settled));
          fetch(`${API}/panel-pos`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(settled),
          }).catch(() => { /* Host 暂不可达时保留本地缓存 */ });
        } catch { /* ignore */ }
      };

      /* ── 派生状态 ── */

      const build = (data && data.build) || {};
      const server = (data && data.server) || {};
      const healthy = Boolean(data && data.healthy);
      const running = Boolean(server.running);
      const projectValid = Boolean(data && data.projectValid);
      const installState = (data && data.install) || {};
      const installing = installState.status === 'running';
      const projectUpdate = (data && data.projectUpdate) || {};
      const updatingProject = projectUpdate.status === 'running';
      const projectPackage = (data && data.projectPackage) || 'remotion-studio-mcp';

      const plugin = (data && data.plugin) || {};
      const updateInfo = (data && data.update) || {};
      const pu = (data && data.pluginUpdate) || { status: 'idle' };
      const pluginVer = plugin.version || (data && data.pluginVersion) || '—';
      const pluginKind = plugin.kind || (data && data.pluginSource) || 'unknown';
      const canAutoUpdate = Boolean(plugin.canAutoUpdate);
      const hotUpdate = Boolean(plugin.hot);
      const hasUpdate = Boolean(updateInfo.hasUpdate);
      const projectHasUpdate = Boolean(updateInfo.projectHasUpdate);

      const pluginUpdating = pu.status === 'removing' || pu.status === 'installing';
      const pluginUpdateDone = pu.status === 'done';
      const pluginUpdateBad = pu.status === 'failed' || pu.status === 'rolled-back' || pu.status === 'interrupted';
      /** 更新结果横幅要一直显示到用户点「知道了」，但「有新版本」的横幅让位 */
      const showResultBanner = pluginUpdating || pluginUpdateDone || pluginUpdateBad;
      const bannerUpdate = !showResultBanner && hasUpdate;

      const isExternal = server.status === 'external';
      const serverBusy = server.status === 'starting' || server.status === 'stopping';
      const canStop = running && !isExternal;
      const stopStuckActive = server.status === 'stopping' && stopStuck;
      const building = build.status === 'running';

      const buildDisabled = !projectValid || busy || running || building || serverBusy;
      const serverDisabled = !projectValid || busy || installing || building
        || (serverBusy && !stopStuckActive) || (running && isExternal);

      const buildLabel = building ? '构建中…' : '构建前端';

      let serverLabel = '启动服务';
      let serverVariant = 'primary';
      let serverTitle = '启动本地服务（npx tsx server/index.ts）';
      if (building) {
        serverLabel = '构建中…';
        serverTitle = '正在构建前端，构建完成后才能启动服务';
      } else if (server.status === 'starting') {
        serverLabel = '启动中…';
      } else if (server.status === 'stopping') {
        serverVariant = 'danger';
        if (stopStuckActive) {
          serverLabel = '强制重置';
          serverTitle = '停止卡住了：只清理插件状态，不动残留进程';
        } else {
          serverLabel = '停止中…';
        }
      } else if (running) {
        if (isExternal) {
          serverLabel = '外部运行中';
          serverVariant = 'default';
          serverTitle = '这个服务不是本插件启动的，请在它自己的窗口里停止';
        } else {
          serverLabel = '停止服务';
          serverVariant = 'danger';
          serverTitle = '停止由本插件启动的服务';
        }
      } else if (server.status === 'failed') {
        serverLabel = '重试启动';
        serverTitle = '上次启动失败，重试一次';
      }

      const url = (data && data.url) || '';
      const visibleLogs = logs.filter((entry) => entry.seq > clearedSeq);

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const panelW = Math.min(400, vw - 24);
      const defaultPanelPos = (() => {
        const left = Math.min(Math.max(8, pos.x + BTN - panelW), Math.max(8, vw - panelW - 8));
        const top = pos.y - 12 >= 320 ? Math.max(8, pos.y - 460) : pos.y + BTN + 10;
        return clampPanelPos({ x: left, y: top });
      })();
      const pp = panelPos ? clampPanelPos(panelPos) : defaultPanelPos;
      /**
       * 高度：内容矮就跟内容一样高，最高只到视口的 60% —— 面板是浮在画布上的工具，
       * 再高就把底下的页面盖没了；超出部分在面板内部滚动，而不是把面板拉长。
       * 下限 220px 兜住小窗口（60% 会矮到连标题栏加一行都放不下）。
       * 位置：拖动时完全跟手；不拖时如果装不下就往上让，底部永远留 12px。
       */
      const panelMaxH = Math.max(220, Math.min(Math.round(vh * 0.6), vh - 16));
      const fittedTop = panelH > 0
        ? Math.max(8, Math.min(pp.y, vh - 12 - panelH))
        : pp.y;
      const panelStyle = {
        ...S.panel,
        left: pp.x,
        top: panelDragging ? pp.y : fittedTop,
        width: panelW,
        // 高度只由内容和视口决定：拖动时若跟着 top 变，往下拖会把面板越拖越矮
        maxHeight: panelMaxH,
      };

      const fabStyle = {
        ...S.fab,
        left: pos.x,
        top: pos.y,
        ...(hovering && !dragging ? S.fabHover : {}),
        ...(dragging ? S.fabDragging : {}),
        ...(open ? S.fabOpen : {}),
      };

      const fab = h('button', {
        key: 'fab',
        type: 'button',
        style: fabStyle,
        title: hasUpdate
          ? `Remotion Studio 启动器（启动器有新版本 ${updateInfo.latest}）`
          : (open ? '收起 Remotion Studio 启动器' : 'Remotion Studio 启动器（可拖动）'),
        'aria-label': open ? '收起 Remotion Studio 启动器' : '打开 Remotion Studio 启动器',
        'aria-expanded': open,
        onPointerDown,
        onPointerMove,
        onPointerUp: finishDrag,
        onPointerCancel: finishDrag,
        onPointerEnter: () => setHovering(true),
        onPointerLeave: () => setHovering(false),
        onKeyDown,
      }, [
        h('span', { key: 'i' }, open ? '\u00D7' : '\u{1F3AC}'),
        hasUpdate || pluginUpdating
          ? h('span', { key: 'd', style: { ...S.badge, background: pluginUpdating ? C.accent : C.warn } })
          : null,
      ]);

      if (!open) return fab;

      /* ── 更新横幅 ── */
      function renderBanner() {
        if (pluginUpdating) {
          return h('div', {
            key: 'bn',
            style: {
              ...S.banner,
              borderColor: 'rgba(122,166,248,0.42)',
              background: 'rgba(122,166,248,0.12)',
            },
          }, [
            dot(C.accent, 6),
            h('div', { key: 't', style: S.bannerText }, [
              h('span', { key: 'a', style: { ...S.bannerTitle, color: '#cfe0ff' } },
                pu.status === 'removing' ? '正在卸载旧版…' : '正在安装新版本…'),
              h('span', { key: 'b', style: S.bannerDetail },
                `${pu.from || '?'} → ${pu.to || '?'}　面板可能会消失一下，装完自己回来`),
            ]),
          ]);
        }
        if (pluginUpdateDone) {
          return h('div', {
            key: 'bn',
            style: {
              ...S.banner,
              borderColor: 'rgba(74,222,128,0.38)',
              background: 'rgba(74,222,128,0.10)',
            },
          }, [
            dot(C.ok, 6),
            h('div', { key: 't', style: S.bannerText }, [
              h('span', { key: 'a', style: { ...S.bannerTitle, color: '#c9f7d8' } },
                `已更新到 ${pu.to || pluginVer}`),
              h('span', { key: 'b', style: S.bannerDetail },
                pu.restartRequired ? '重启 DSH 后生效' : '热更新完成，没有重启 DSH'),
            ]),
            h(ActButton, { key: 'x', variant: 'mini', onClick: ackPluginUpdate }, '知道了'),
          ]);
        }
        if (pluginUpdateBad) {
          return h('div', {
            key: 'bn',
            style: {
              ...S.banner,
              borderColor: 'rgba(248,113,113,0.40)',
              background: 'rgba(248,113,113,0.10)',
            },
          }, [
            dot(C.bad, 6),
            h('div', { key: 't', style: S.bannerText }, [
              h('span', { key: 'a', style: { ...S.bannerTitle, color: '#ffd0d0' } },
                pu.status === 'interrupted' ? '上次更新没有走完' : '更新启动器失败'),
              h('span', { key: 'b', style: { ...S.bannerDetail, wordBreak: 'break-word' } },
                `${pu.error || '未知原因'}${pu.rollback ? `（${pu.rollback}）` : ''}`),
            ]),
            h(ActButton, { key: 'x', variant: 'mini', onClick: ackPluginUpdate }, '知道了'),
          ]);
        }
        if (!bannerUpdate) return null;
        return h('div', {
          key: 'bn',
          style: {
            ...S.banner,
            borderColor: 'rgba(251,191,36,0.42)',
            background: 'rgba(251,191,36,0.11)',
            cursor: 'pointer',
          },
          onClick: () => setShowUpdate(true),
        }, [
          dot(C.warn, 6),
          h('div', { key: 't', style: S.bannerText }, [
            h('span', { key: 'a', style: { ...S.bannerTitle, color: '#ffe9b0' } },
              `启动器 ${updateInfo.latest} 可用`),
            h('span', { key: 'b', style: S.bannerDetail },
              canAutoUpdate
                ? (confirmUpdate
                  ? '再点一次就开始更新（面板会消失一两秒）'
                  : `当前 ${pluginVer}　${hotUpdate ? '可一键热更新，无需重启' : '更新后需重启 DSH'}`)
                : `当前 ${pluginVer}（${KIND_LABEL[pluginKind] || pluginKind}），需要手动重装`),
          ]),
          h(ActButton, {
            key: 'a',
            variant: 'mini',
            onClick: (event) => {
              if (event && event.stopPropagation) event.stopPropagation();
              if (canAutoUpdate) void runPluginUpdate();
              else setShowUpdate(true);
            },
          }, canAutoUpdate
            ? (confirmUpdate ? '确认更新' : '更新')
            : '查看'),
        ]);
      }

      /* ── 更新详情 ── */
      function renderUpdate() {
        const rows = [];
        rows.push(h('div', { key: 'p', style: S.row }, [
          h('span', { key: 'l', style: S.label }, '启动器'),
          h('span', {
            key: 'v',
            style: { ...S.value, ...S.ellipsis, fontSize: 11.4 },
            title: plugin.spec || '',
          }, `${pluginVer}${updateInfo.latest && updateInfo.latest !== pluginVer ? ` → ${updateInfo.latest}` : (updateInfo.latest ? '（已最新）' : '')}`),
          h('span', {
            key: 'k',
            style: { fontSize: 10.4, color: C.faint, flex: '0 0 auto' },
          }, KIND_LABEL[pluginKind] || pluginKind),
        ]));

        if (canAutoUpdate && hasUpdate) {
          rows.push(h('div', { key: 'act', style: { display: 'flex', flexDirection: 'column', gap: 5 } }, [
            h(ActButton, {
              key: 'u',
              variant: 'primary',
              style: { flex: '0 0 auto' },
              disabled: busy || pluginUpdating,
              onClick: runPluginUpdate,
            }, confirmUpdate ? '再点一次确认更新' : (pluginUpdating ? '更新中…' : '一键更新启动器')),
            h('div', { key: 'h', style: S.hint },
              hotUpdate
                ? '会先卸载再用新版装回来，全程不重启 DSH；面板可能消失一两秒，装完自动回来。'
                : '当前 DSH 没开 HMR：会装上最新版，但需要重启 DSH 才生效。'),
          ]));
        } else if (hasUpdate && pluginKind !== 'npm') {
          rows.push(h('div', { key: 'man', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
            h('div', { key: 't', style: { ...S.hint, color: C.warn } },
              `${KIND_LABEL[pluginKind] || pluginKind}：面板里不能自动升级，请手动卸载后重装。`),
            h('div', { key: 's', style: S.hint }, '① 设置 → 插件 → 找到 dsh-remotion-launcher，卸载'),
            h('div', { key: 's2', style: S.hint }, '② 再按原来的方式装回来（或命令行）：'),
            h('pre', { key: 'p', style: S.pre },
              `dsh plugin --profile web remove dsh-remotion-launcher\ndsh plugin --profile web add ${plugin.manualSpec || plugin.spec || 'dsh-remotion-launcher'}`),
            pluginKind === 'link'
              ? h('div', { key: 'x', style: S.hint }, '本地源码链接安装的话，更新源码目录后重启 DSH 也可以。')
              : null,
          ]));
        } else if (hasUpdate && pluginKind === 'npm' && !canAutoUpdate) {
          rows.push(h('div', { key: 'no', style: S.hint },
            '当前 DSH 没有暴露插件管理接口，请到「设置 → 插件」里卸载后重装最新版。'));
        } else if (!updateInfo.latest && updateInfo.error) {
          rows.push(h('div', { key: 'e', style: { ...S.hint, color: C.bad } }, updateInfo.error));
        } else if (!hasUpdate && updateInfo.checkedAt) {
          rows.push(h('div', { key: 'o', style: S.hint }, '启动器已经是最新版本。'));
        }

        rows.push(h('div', { key: 'proj', style: { ...S.row, marginTop: 2 } }, [
          h('span', { key: 'l', style: S.label }, '工程'),
          h('span', {
            key: 'v',
            style: { ...S.value, ...S.ellipsis, fontSize: 11.4 },
          }, `${projectUpdate.to || (data && data.projectVersion) || '当前'}${projectHasUpdate ? ` → ${updateInfo.projectLatest}` : (updateInfo.projectLatest ? '（已最新）' : '')}`),
          h(ActButton, {
            key: 'b',
            variant: 'mini',
            disabled: busy || updatingProject || !projectValid || !projectHasUpdate,
            title: '原地更新工程代码，保留 data / public / out',
            onClick: runProjectUpdate,
          }, updatingProject ? '…' : '更新'),
        ]));

        if (updatingProject) rows.push(h('div', { key: 'rp', style: S.hint }, '正在更新工程，进度见下方日志…'));
        if (projectUpdate.status === 'failed') {
          rows.push(h('div', { key: 'rf', style: S.err }, projectUpdate.error || '工程更新失败'));
        }

        rows.push(h('div', { key: 'foot', style: { ...S.hint, display: 'flex', alignItems: 'center', gap: 6 } }, [
          h('span', { key: 'a' },
            updateInfo.checkedAt
              ? `上次检查 ${timeText(updateInfo.checkedAt)}　源：${updateInfo.registry || effectiveRegistry}`
              : `源：${effectiveRegistry}`),
          h('span', { key: 's', style: { flex: '1 1 auto' } }),
          h(ActButton, {
            key: 'c',
            variant: 'mini',
            disabled: checking,
            onClick: checkUpdates,
          }, checking ? '查询中…' : '重新检查'),
        ]));

        return h('div', { key: 'upd', style: { ...S.section, background: 'rgba(255,255,255,0.03)' } }, [
          h('div', { key: 'h', style: { ...S.sectionHead, cursor: 'default' } }, [
            h('span', { key: 't', style: S.sectionTitle }, '版本与更新'),
          ]),
          h('div', { key: 'b', style: { ...S.sectionBody, borderTop: 'none', paddingTop: 0 } },
            rows.concat(pluginMsg ? [h('div', { key: 'm', style: S.err }, pluginMsg)] : [])),
        ]);
      }

      /* ── 安装 / 更换工程 ── */
      function renderInstall() {
        return h('div', { key: 'inst', style: { display: 'flex', flexDirection: 'column', gap: 8 } }, [
          h('div', { key: 't', style: { ...S.hint, color: C.dim } },
            '选一个本机已有的工程目录直接使用；还没有工程的话，再从 npm 下载一份。'),

          h('div', { key: 'r1', style: S.row }, [
            h('span', { style: S.label }, '目录'),
            h('input', {
              type: 'text',
              value: installDir,
              placeholder: '点「选择」或直接粘贴路径',
              style: S.input,
              disabled: busy || installing,
              onChange: (e) => setInstallDir(e.target.value),
            }),
            h(ActButton, {
              variant: 'mini',
              disabled: busy || picking || installing,
              title: '弹系统文件夹选择框',
              onClick: chooseInstallDir,
            }, picking ? '…' : '选择'),
          ]),

          h('div', { key: 'r2', style: S.actions }, [
            h(ActButton, {
              variant: 'primary',
              disabled: busy || installing || !installDir.trim(),
              title: '用这个已存在的工程目录（不会下载任何东西）',
              onClick: useExistingProject,
            }, '使用此目录'),
            h(ActButton, {
              variant: 'default',
              disabled: busy || installing || !installDir.trim(),
              title: 'npm pack → 解压 → npm install',
              onClick: startInstall,
            }, installing ? '下载中…' : '下载并安装'),
          ]),

          picking
            ? h('div', { key: 'pk', style: S.hint },
              '系统文件夹对话框已弹出（可能被 DSH 窗口挡住，留意任务栏），选好点确定。')
            : null,

          h('div', { key: 'r3', style: S.row }, [
            h('span', { style: S.label }, '下载源'),
            h('button', {
              type: 'button',
              disabled: busy || installing,
              'aria-expanded': registryMenuOpen,
              style: {
                ...S.selectBtn,
                ...(busy || installing ? S.selectDisabled : {}),
                ...(registryMenuOpen ? { borderColor: 'rgba(120,165,250,0.6)' } : {}),
              },
              onClick: () => setRegistryMenuOpen((v) => !v),
            }, [
              h('span', { key: 'l' },
                (REGISTRY_CHOICES.find((c) => c.value === registryChoice) || REGISTRY_CHOICES[0]).label),
              h('span', { key: 'a', style: S.selectArrow }, registryMenuOpen ? '▴' : '▾'),
            ]),
          ]),

          registryMenuOpen ? h('div', { key: 'rm', style: S.selectMenu }, REGISTRY_CHOICES.map((choice) => h('button', {
            key: choice.value,
            type: 'button',
            style: {
              ...S.selectItem,
              ...(hoverReg === choice.value || choice.value === registryChoice ? S.selectItemActive : {}),
            },
            onPointerEnter: () => setHoverReg(choice.value),
            onPointerLeave: () => setHoverReg(null),
            onClick: () => {
              setRegistryChoice(choice.value);
              setRegistryMenuOpen(false);
              setHoverReg(null);
              if (choice.value !== 'custom') void applyRegistry(choice.value);
            },
          }, choice.label))) : null,

          registryChoice === 'custom' ? h('div', { key: 'r4', style: S.row }, [
            h('span', { style: S.label }, '地址'),
            h('input', {
              type: 'text',
              value: customRegistry,
              placeholder: 'https://registry.npmjs.org',
              style: S.input,
              disabled: busy || installing,
              onChange: (e) => setCustomRegistry(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') { e.preventDefault(); void applyRegistry(customRegistry.trim()); }
              },
            }),
            h(ActButton, {
              variant: 'mini',
              disabled: busy || installing || !customRegistry.trim(),
              onClick: () => applyRegistry(customRegistry.trim()),
            }, '应用'),
          ]) : null,

          installState.status === 'failed'
            ? h('div', { key: 'f', style: S.err }, installState.error || '安装失败，看下方日志')
            : installing
              ? h('div', { key: 'p', style: S.hint }, '进度见下方日志…')
              : null,
        ]);
      }

      /* ── 设置折叠区 ── */
      function renderSettings() {
        return h('div', { key: 'set', style: S.section }, [
          h(SectionHead, {
            key: 'h',
            open: showSettings,
            label: '设置与安装',
            badge: projectValid ? '工程已就绪' : '还没装工程',
            onClick: () => setShowSettings((v) => !v),
          }),
          showSettings ? h('div', { key: 'b', style: S.sectionBody }, [
            h('div', { key: 'p', style: S.row }, [
              h('span', { key: 'l', style: S.label }, '工程'),
              h('span', {
                key: 'v',
                style: { ...S.value, ...S.ellipsis, color: projectValid ? C.text : C.faint },
                title: (data && data.projectRoot) || '',
              }, projectValid ? ((data && data.projectRoot) || '已就绪') : '未安装'),
              h(ActButton, {
                key: 'b',
                variant: 'mini',
                disabled: busy || installing || updatingProject,
                title: projectValid ? '换一个工程目录' : '选择目录并下载工程',
                onClick: () => setShowInstall((v) => !v),
              }, showInstall ? '收起' : (projectValid ? '更换' : '安装')),
            ]),

            showInstall ? renderInstall() : null,

            h('div', { key: 'port', style: S.row }, [
              h('span', { key: 'l', style: S.label }, '端口'),
              h('input', {
                key: 'i',
                type: 'number', min: 1024, max: 65535, step: 1,
                value: portDraft,
                style: S.input,
                disabled: running,
                'aria-label': '运行端口',
                title: running ? '先停止服务再改端口' : '改完点「应用」，下次启动用这个端口',
                onChange: (e) => setPortDraft(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') { e.preventDefault(); applyPort(); }
                },
              }),
              h(ActButton, {
                key: 'b',
                variant: 'mini',
                disabled: busy || running,
                title: running ? '先停止服务再改端口' : '应用端口，下次启动生效',
                onClick: applyPort,
              }, running ? '运行中' : '应用'),
            ]),
          ]) : null,
        ]);
      }

      /**
       * MCP 配置：一段 JSON 复制走，直接粘到连接器管理页。
       *
       * 路径和端口都由 host 算好（工程目录、当前端口），客户端只负责选接法和复制，
       * 免得用户自己拼 `<工程目录>` 拼错。
       */
      function renderMcp() {
        const mcp = data && data.mcp;
        if (!mcp) return null;
        const isHttp = mcpMode === 'http';
        const json = JSON.stringify(isHttp ? mcp.http : mcp.stdio, null, 2);
        const ready = isHttp ? mcp.httpReady : mcp.stdioReady;
        const endpoint = isHttp ? mcp.httpUrl : mcp.serverUrl;
        const note = !projectValid
          ? '还没装工程，配置里的路径暂时不可用'
          : isHttp
            ? (mcp.httpReady ? '连正在跑的服务，改代码不用重连；服务一停就断' : '服务没在跑，先在上面点「启动」')
            : (mcp.stdioReady ? '常驻子进程，首次调用自动拉起服务；改工具代码要重连' : '工程依赖没装齐，先构建一次再复制');

        return h('div', { key: 'mcp', style: S.section }, [
          h('div', { key: 'h', style: S.mcpHead }, [
            h('button', {
              key: 't', type: 'button', style: S.mcpTitle,
              title: mcpOpen ? '收起 JSON' : '展开看一眼要复制的 JSON',
              onClick: () => setMcpOpen((v) => !v),
            }, [
              h('span', { key: 'c', style: S.caret }, mcpOpen ? '▾' : '▸'),
              h('span', { key: 'l' }, 'MCP 配置'),
              dot(ready ? C.ok : C.warn, 5),
            ]),
            h('div', {
              key: 'seg', style: S.seg, role: 'group', 'aria-label': 'MCP 接法',
            }, [
              h('button', {
                key: 's', type: 'button',
                style: { ...S.segBtn, ...(isHttp ? {} : S.segBtnActive) },
                title: 'stdio：常驻子进程，服务没开也能用（推荐）',
                onClick: () => switchMcpMode('stdio'),
              }, 'stdio'),
              h('button', {
                key: 'h', type: 'button',
                style: { ...S.segBtn, ...(isHttp ? S.segBtnActive : {}) },
                title: 'HTTP：连正在跑的服务（地址要带 /mcp）',
                onClick: () => switchMcpMode('http'),
              }, 'HTTP'),
            ]),
            h(ActButton, {
              key: 'c',
              variant: 'mini',
              style: { padding: '3px 8px', fontSize: 10.8 },
              title: '复制这段 JSON，粘到连接器管理页的自定义连接器里',
              onClick: () => runMcpCopy(json),
            }, mcpCopied ? '已复制' : '复制 JSON'),
          ]),
          h('div', { key: 'b', style: S.mcpBody }, [
            h('div', { key: 'u', style: S.row }, [
              h('span', { key: 'l', style: S.label }, isHttp ? '端点' : '服务'),
              h('span', {
                key: 'v',
                style: { ...S.value, ...S.ellipsis },
                title: endpoint,
              }, endpoint),
            ]),
            mcpFailed
              ? h('div', { key: 'n', style: S.mcpErr }, '复制失败：浏览器不让写剪贴板。已展开下面的 JSON，全选复制即可')
              : h('div', { key: 'n', style: S.hint }, note),
            mcpOpen ? h('pre', { key: 'p', style: S.mcpPre, 'data-rsl-scroll': '' }, json) : null,
          ]),
        ]);
      }

      function switchMcpMode(mode) {
        setMcpMode(mode);
        try { window.localStorage.setItem(MCP_MODE_KEY, mode); } catch { /* ignore */ }
      }

      function runMcpCopy(json) {
        setMcpFailed(false);
        void copyText(json).then((ok) => {
          if (!ok) {
            setMcpFailed(true);
            setMcpOpen(true);
            return;
          }
          setMcpCopied(true);
          setTimeout(() => setMcpCopied(false), 1400);
        });
      }

      return h('div', { style: panelStyle, key: 'panel', ref: panelElRef }, [
        /* 标题栏（可拖动） */
        h('div', {
          key: 'head',
          style: {
            ...S.head,
            cursor: panelDragging ? 'grabbing' : 'grab',
            userSelect: 'none',
            touchAction: 'none',
          },
          title: '拖动标题栏移动面板',
          onPointerDown: onPanelHeadDown,
          onPointerMove: onPanelHeadMove,
          onPointerUp: onPanelHeadUp,
          onPointerCancel: onPanelHeadUp,
        }, [
          h('div', { style: S.titleWrap, key: 'tw' }, [
            dot(healthy ? C.ok : running ? C.warn : C.faint),
            h('span', { style: S.title, key: 't' }, 'Remotion Studio'),
            h('span', { style: S.verChip, key: 'v' }, `v${pluginVer}`),
          ]),
          h('div', { key: 'ha', style: S.headActions }, [
            h(IconButton, {
              key: 'u',
              title: '版本与更新',
              active: showUpdate,
              onClick: () => setShowUpdate((v) => !v),
            }, '⟳'),
            h(IconButton, {
              key: 'x',
              title: '收起',
              onClick: () => setOpen(false),
            }, '×'),
          ]),
        ]),

        h('div', { style: S.body, key: 'body', 'data-rsl-scroll': '' }, [
          renderBanner(),

          /* 主状态卡：状态 + 地址 + 主按钮 */
          h('div', { key: 'hero', style: S.hero }, [
            h('div', { key: 'top', style: S.heroTop }, [
              dot(tone(isExternal ? 'running' : server.status)),
              h('span', { style: S.heroStatus, key: 's' }, SERVER_TEXT[server.status] || server.status || '—'),
              h('span', { style: S.portChip, key: 'p' }, `:${(data && data.port) || '—'}`),
            ]),
            h('div', { key: 'url', style: S.urlRow }, [
              h('span', {
                key: 't',
                style: { ...S.urlText, ...(url && running ? {} : S.urlEmpty) },
                title: url || '',
              }, url && running ? url : (url ? `${url}（未启动）` : '服务未运行')),
              running
                ? h(ActButton, {
                  key: 'c',
                  variant: 'mini',
                  style: { padding: '2px 6px', fontSize: 10.4 },
                  title: '复制地址',
                  onClick: async () => {
                    if (await copyText(url)) {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1200);
                    }
                  },
                }, copied ? '已复制' : '复制')
                : null,
            ]),
            h('div', { key: 'acts', style: S.actions }, [
              h(ActButton, {
                key: 's',
                variant: serverVariant,
                disabled: serverDisabled,
                title: serverTitle,
                onClick: () => {
                  if (stopStuckActive) return act('/reset', '重置');
                  return canStop ? act('/stop', '停止') : act('/start', '启动');
                },
              }, serverLabel),
              h(ActButton, {
                key: 'b',
                variant: 'default',
                disabled: buildDisabled,
                title: running ? '服务运行中，先停止再构建' : '重新构建前端（vite build → dist/web）',
                onClick: () => act('/build', '构建'),
              }, buildLabel),
            ]),
          ]),

          /* 紧凑信息 */
          h('div', { key: 'meta', style: S.meta }, [
            h('div', { key: 'b', style: S.metaCell }, [
              h('span', { key: 'l', style: S.metaLabel }, '构建'),
              h('span', {
                key: 'v',
                style: { ...S.metaValue, color: tone(build.status) },
              }, `${BUILD_TEXT[build.status] || build.status || '—'}${build.finishedAt ? ` · ${timeText(build.finishedAt)}` : ''}`),
            ]),
            h('div', { key: 'p', style: S.metaCell }, [
              h('span', { key: 'l', style: S.metaLabel }, '工程'),
              h('span', {
                key: 'v',
                style: { ...S.metaValue, color: projectValid ? C.ok : C.faint },
                title: (data && data.projectRoot) || '',
              }, projectValid ? '已就绪' : '未安装'),
            ]),
          ]),

          showUpdate ? renderUpdate() : null,
          renderMcp(),
          renderSettings(),

          error ? h('div', { style: S.err, key: 'err' }, error) : null,

          /* 日志 */
          h('div', { key: 'logsHead', style: S.logsHead }, [
            h('span', { key: 't', style: S.logsTitle }, '日志'),
            h('span', { key: 'n', style: { ...S.logsTitle, color: C.faint, letterSpacing: 0 } },
              visibleLogs.length ? `${visibleLogs.length}` : ''),
            h('span', { key: 's', style: { flex: '1 1 auto' } }),
            h(ActButton, {
              key: 'c',
              variant: 'mini',
              style: { padding: '2px 7px', fontSize: 10.4 },
              title: '只清空这里的显示，Host 的缓冲不动',
              onClick: () => setClearedSeq(seqRef.current),
            }, '清空'),
          ]),

          h('div', { key: 'logs', ref: boxRef, style: S.logBox, 'data-rsl-scroll': '' }, visibleLogs.length === 0
            ? [h('div', { key: 'empty', style: { color: C.faint } }, '暂无日志')]
            : visibleLogs.map((entry) => h('div', {
              key: entry.seq,
              style: {
                ...S.logLine,
                color: entry.stream === 'server' ? '#9ec1ff'
                  : entry.stream === 'build' ? '#d8c7a0'
                    : entry.stream === 'install' ? '#a9dcb4'
                      : C.faint,
              },
            }, entry.text))),

          h('div', { style: S.hint, key: 'hint' },
            `构建产物在 dist/web；启动后在右侧栏「浏览器」打开地址即可。`),
        ]),
      ]);
    }

    function apply(ctx) {
      clientCtx = ctx;
      ensureScrollStyles();

      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'remotion-launcher',
        order: 220,
      }, LauncherOverlay)), 'dsh-remotion-launcher: overlay');
    }

    exports.apply = apply;
    // remote 用于目录选择（remote.directoryPicker）；取不到时回退到 host 的系统对话框
    exports.inject = ['slots', 'remote'];
    return module.exports;
  },
});
