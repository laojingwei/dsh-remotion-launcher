/**
 * dsh-remotion-launcher —— Client 半部
 *
 * 形态：官方 Client 模块（window.__ModuleLoader__.load + factory）。
 * 在 shell.overlay 里挂一个可拖动的悬浮按钮 + 启动面板：
 *   · 构建前端（vite build）
 *   · 启动 / 停止 Remotion Studio 服务
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

    const REGISTRY_CHOICES = [
      { value: 'https://registry.npmmirror.com', label: '国内镜像 npmmirror' },
      { value: 'https://registry.npmjs.org', label: 'npm 官方' },
      { value: 'custom', label: '自定义…' },
    ];

    const C = {
      bg: 'rgba(22, 25, 33, 0.96)',
      bgSoft: 'rgba(255,255,255,0.055)',
      border: 'rgba(255,255,255,0.10)',
      borderStrong: 'rgba(140,170,235,0.34)',
      text: '#e9ecf3',
      dim: '#98a0b0',
      faint: '#6d7585',
      ok: '#4ade80',
      warn: '#fbbf24',
      bad: '#f87171',
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
      fabHover: {
        background: 'rgba(52, 58, 74, 0.88)',
      },
      fabDragging: {
        transform: 'scale(1.08)',
        background: 'rgba(52, 58, 74, 0.95)',
        cursor: 'grabbing',
      },
      fabOpen: {
        background: 'rgba(58, 66, 86, 0.95)',
      },
      panel: {
        position: 'fixed', zIndex: 2147483000,
        display: 'flex', flexDirection: 'column',
        background: C.bg, color: C.text,
        border: `1px solid ${C.border}`, borderRadius: 16, overflow: 'hidden',
        boxShadow: '0 24px 64px rgba(0,0,0,0.62), inset 0 1px 0 rgba(255,255,255,0.05)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
        fontSize: 13,
      },
      head: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        padding: '12px 14px', borderBottom: `1px solid ${C.border}`,
        background: 'rgba(255,255,255,0.02)',
      },
      titleWrap: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      title: { fontWeight: 600, fontSize: 13, letterSpacing: 0.2, color: C.text },
      subtitle: { color: C.faint, fontSize: 11, fontFamily: C.mono },
      close: {
        background: 'transparent', border: 'none', color: C.dim, cursor: 'pointer',
        fontSize: 16, lineHeight: 1, padding: '4px 6px', borderRadius: 8,
      },
      body: { padding: 12, display: 'flex', flexDirection: 'column', gap: 10, overflow: 'auto' },
      row: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, minWidth: 0 },
      label: { color: C.dim, minWidth: 52, flex: '0 0 auto' },
      value: { color: C.text, fontSize: 12.5, wordBreak: 'break-all', fontFamily: C.mono },
      actions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
      portInput: {
        flex: '1 1 auto', minWidth: 0, padding: '5px 8px', borderRadius: 8,
        border: `1px solid ${C.border}`, background: 'rgba(0,0,0,0.28)',
        color: C.text, fontSize: 12.5, fontFamily: C.mono, outline: 'none',
      },
      portBtn: {
        flex: '0 0 auto', padding: '5px 10px', borderRadius: 8,
        border: `1px solid ${C.border}`, background: C.bgSoft, color: C.text,
        cursor: 'pointer', fontSize: 12,
        transition: 'background 120ms ease, border-color 120ms ease, transform 90ms ease, opacity 120ms ease',
      },
      installCard: {
        display: 'flex', flexDirection: 'column', gap: 9,
        padding: '12px 12px 14px', borderRadius: 12,
        border: `1px solid ${C.border}`, background: 'rgba(255,255,255,0.03)',
      },
      installTitle: { fontSize: 12.5, fontWeight: 600, color: C.text },
      installHint: { fontSize: 11.2, color: C.faint, lineHeight: 1.5 },
      installRow: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
      selectBtn: {
        flex: '1 1 auto', minWidth: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        padding: '5px 9px', borderRadius: 8,
        border: `1px solid ${C.border}`, background: 'rgba(0,0,0,0.28)',
        color: C.text, fontSize: 12.5, cursor: 'pointer',
        transition: 'background 120ms ease, border-color 120ms ease',
      },
      selectDisabled: { opacity: 0.45, cursor: 'not-allowed' },
      selectArrow: { color: C.dim, fontSize: 10, lineHeight: 1 },
      selectMenu: {
        display: 'flex', flexDirection: 'column', gap: 2,
        padding: 4, borderRadius: 9,
        background: 'rgba(0,0,0,0.34)', border: `1px solid ${C.border}`,
      },
      selectItem: {
        textAlign: 'left', padding: '6px 9px', borderRadius: 6,
        border: 'none', background: 'transparent', color: C.text,
        fontSize: 12.5, cursor: 'pointer',
        transition: 'background 100ms ease',
      },
      selectItemActive: { background: 'rgba(110,168,254,0.20)', color: '#d5e4ff' },
      actions: { display: 'flex', gap: 10, flexWrap: 'wrap' },
      btn: {
        flex: '1 1 0', minWidth: 0, padding: '9px 10px', borderRadius: 10,
        border: `1px solid ${C.border}`, background: C.bgSoft, color: C.text,
        cursor: 'pointer', fontSize: 12.5, fontWeight: 500,
        transition: 'background 120ms ease, border-color 120ms ease, transform 90ms ease, opacity 120ms ease',
      },
      btnPrimary: {
        flex: '1 1 0', minWidth: 0, padding: '9px 10px', borderRadius: 10,
        border: '1px solid rgba(120, 165, 250, 0.55)',
        background: 'linear-gradient(160deg, rgba(78, 116, 190, 0.55), rgba(52, 78, 132, 0.55))',
        color: '#e9f0ff', cursor: 'pointer', fontSize: 12.5, fontWeight: 500,
        transition: 'background 120ms ease, border-color 120ms ease, transform 90ms ease, opacity 120ms ease',
      },
      btnDanger: {
        flex: '1 1 0', minWidth: 0, padding: '9px 10px', borderRadius: 10,
        border: '1px solid rgba(248, 113, 113, 0.45)',
        background: 'rgba(248, 113, 113, 0.12)',
        color: '#ffc9c9', cursor: 'pointer', fontSize: 12.5, fontWeight: 500,
        transition: 'background 120ms ease, border-color 120ms ease, transform 90ms ease, opacity 120ms ease',
      },
      logBox: {
        height: 200, overflow: 'auto', background: 'rgba(0,0,0,0.30)',
        border: `1px solid ${C.border}`, borderRadius: 10, padding: '8px 10px',
        fontFamily: C.mono, fontSize: 11.2, lineHeight: 1.55,
      },
      logLine: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      hint: { color: C.faint, fontSize: 11.2, lineHeight: 1.55 },
      err: { color: C.bad, fontSize: 11.5, lineHeight: 1.5 },
    };

    const BUILD_TEXT = { idle: '未构建', running: '构建中', success: '构建成功', failed: '构建失败' };
    const SERVER_TEXT = {
      idle: '未启动', starting: '启动中', running: '运行中',
      external: '已在运行（非本插件启动）', stopping: '停止中', stopped: '已停止', failed: '启动失败',
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

    /** 面板自己的位置：只保证整块留在视口里，不跟随按钮 */
    function clampPanelPos(point) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.min(372, vw - 36);
      return {
        x: Math.min(Math.max(8, Math.round(point.x)), Math.max(8, vw - w - 8)),
        y: Math.min(Math.max(8, Math.round(point.y)), Math.max(8, vh - 120)),
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

    /* ── 小组件 ───────────────────────────────────────────────── */

    function dot(color) {
      return h('span', {
        style: {
          width: 7, height: 7, borderRadius: 4, background: color,
          display: 'inline-block', flex: '0 0 auto',
          boxShadow: color === C.dim ? 'none' : `0 0 8px ${color}`,
        },
      });
    }

    function tone(value) {
      if (value === 'success' || value === 'running') return C.ok;
      if (value === 'starting') return C.warn;
      if (value === 'failed') return C.bad;
      return C.dim;
    }

    function timeText(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    /* ── 交互按钮（内联样式没有 :hover，只能自己管状态） ───────── */

    const BUTTON_VARIANTS = {
      default: {
        base: S.btn,
        hover: { background: 'rgba(255,255,255,0.12)', borderColor: 'rgba(255,255,255,0.22)' },
      },
      primary: {
        base: S.btnPrimary,
        hover: {
          background: 'linear-gradient(160deg, rgba(96, 138, 214, 0.78), rgba(64, 94, 156, 0.78))',
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
      port: {
        base: S.portBtn,
        hover: { background: 'rgba(255,255,255,0.13)', borderColor: 'rgba(255,255,255,0.24)' },
      },
    };

    function ActButton({ children, onClick, disabled, variant, title }) {
      const [hover, setHover] = React.useState(false);
      const [pressed, setPressed] = React.useState(false);
      const v = BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.default;
      const style = {
        ...v.base,
        ...(hover && !disabled ? v.hover : {}),
        ...(pressed && !disabled ? { transform: 'scale(0.975)' } : {}),
        ...(disabled ? { opacity: 0.42, cursor: 'not-allowed', filter: 'saturate(0.6)' } : {}),
      };
      return h('button', {
        type: 'button',
        style,
        disabled: Boolean(disabled),
        title,
        onClick,
        onPointerEnter: () => setHover(true),
        onPointerLeave: () => { setHover(false); setPressed(false); },
        onPointerDown: () => { if (!disabled) setPressed(true); },
        onPointerUp: () => setPressed(false),
      }, children);
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
      const [registryChoice, setRegistryChoice] = React.useState('https://registry.npmmirror.com');
      const [customRegistry, setCustomRegistry] = React.useState('');
      const [picking, setPicking] = React.useState(false);
      /** 安装/更换工程卡片是否展开（没工程时自动展开） */
      const [showInstall, setShowInstall] = React.useState(false);
      const installAutoShownRef = React.useRef(false);
      /** 下载源用自绘下拉（原生 select 的选项列表跟深色面板冲突，字看不清） */
      const [registryMenuOpen, setRegistryMenuOpen] = React.useState(false);
      const [hoverReg, setHoverReg] = React.useState(null);
      /** 面板自身位置（可拖标题栏移动）；null = 还没定过，按按钮位置算 */
      const [panelPos, setPanelPos] = React.useState(loadPanelPos);
      const [panelDragging, setPanelDragging] = React.useState(false);

      const seqRef = React.useRef(0);
      const logsRef = React.useRef([]);
      const boxRef = React.useRef(null);
      const pullRef = React.useRef(() => {});
      const dragRef = React.useRef(null);
      const movedRef = React.useRef(false);
      const posSyncedRef = React.useRef(false);
      const portSyncedRef = React.useRef(false);
      const panelDragRef = React.useRef(null);
      const panelPosRef = React.useRef(panelPos);
      const panelSyncedRef = React.useRef(false);
      panelPosRef.current = panelPos;

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

            if (!panelSyncedRef.current && body.panelPos
              && Number.isFinite(body.panelPos.x) && Number.isFinite(body.panelPos.y)) {
              panelSyncedRef.current = true;
              const next = clampPanelPos(body.panelPos);
              panelPosRef.current = next;
              setPanelPos(next);
            }

            if (Array.isArray(body.logs) && body.logs.length > 0) {
              for (const entry of body.logs) {
                seqRef.current = Math.max(seqRef.current, entry.seq || 0);
              }
              logsRef.current = logsRef.current.concat(body.logs).slice(-500);
              setLogs(logsRef.current.slice());
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
        // 第一次拿到状态：没工程就自动把安装卡片展开
        if (!installAutoShownRef.current) {
          installAutoShownRef.current = true;
          if (!data.projectValid) setShowInstall(true);
        }
        // 安装成功后收起卡片，目录清空（下次换工程重新选）
        if (showInstall && data.install && data.install.status === 'success') {
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

      /* 拖动标题栏：面板自己走，和悬浮按钮各管各的位置 */
      const onPanelHeadDown = (event) => {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        if (event.target instanceof Element && event.target.closest('button')) return;
        const origin = panelPosRef.current || { x: 0, y: 0 };
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
        });
        panelPosRef.current = next;
        setPanelPos(next);
      };

      const onPanelHeadUp = (event) => {
        const drag = panelDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        panelDragRef.current = null;
        setPanelDragging(false);
        try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
        try {
          if (panelPosRef.current) {
            window.localStorage.setItem(PANEL_POS_KEY, JSON.stringify(panelPosRef.current));
            fetch(`${API}/panel-pos`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(panelPosRef.current),
            }).catch(() => { /* Host 暂不可达时保留本地缓存 */ });
          }
        } catch { /* ignore */ }
      };

      const build = (data && data.build) || {};
      const server = (data && data.server) || {};
      const healthy = Boolean(data && data.healthy);
      const running = Boolean(server.running);
      /** 工程是否已就位（没就位时先让用户下载） */
      const projectValid = Boolean(data && data.projectValid);
      const installState = (data && data.install) || {};
      const installing = installState.status === 'running';
      const projectPackage = (data && data.projectPackage) || 'remotion-studio-mcp';

      const isExternal = server.status === 'external';
      const serverBusy = server.status === 'starting' || server.status === 'stopping';
      const canStop = running && !isExternal;
      // 停止超过 6 秒还没结束，就给一个「强制重置」的出口，免得按钮永久卡死
      const stopStuckActive = server.status === 'stopping' && stopStuck;

      // 服务在跑时不允许构建（构建会改 dist，运行中容易让人误以为页面已更新）
      const buildDisabled = !projectValid || busy || running || build.status === 'running' || serverBusy;
      // 构建中也不允许启动：dist 正在被重写，这时起服务容易读到半份前端
      const building = build.status === 'running';
      const serverDisabled = !projectValid || busy || installing || building
        || (serverBusy && !stopStuckActive) || (running && isExternal);

      const buildLabel = build.status === 'running' ? '构建中…' : '构建前端';

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

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const panelW = Math.min(372, vw - 36);
      // 没拖过就按悬浮按钮的位置摆一个默认位置；拖过就一直用记住的位置
      const defaultPanelPos = (() => {
        const left = Math.min(Math.max(8, pos.x + BTN - panelW), Math.max(8, vw - panelW - 8));
        const top = pos.y - 12 >= 300 ? Math.max(8, pos.y - 430) : pos.y + BTN + 10;
        return clampPanelPos({ x: left, y: top });
      })();
      const pp = panelPos ? clampPanelPos(panelPos) : defaultPanelPos;
      const panelStyle = {
        ...S.panel,
        left: pp.x,
        top: pp.y,
        width: panelW,
        maxHeight: Math.max(220, Math.min(vh * 0.72, vh - pp.y - 20)),
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
        title: open ? '收起 Remotion Studio 启动器' : 'Remotion Studio 启动器（可拖动）',
        'aria-label': open ? '收起 Remotion Studio 启动器' : '打开 Remotion Studio 启动器',
        'aria-expanded': open,
        onPointerDown,
        onPointerMove,
        onPointerUp: finishDrag,
        onPointerCancel: finishDrag,
        onPointerEnter: () => setHovering(true),
        onPointerLeave: () => setHovering(false),
        onKeyDown,
      }, open ? '\u00D7' : '\u{1F3AC}');

      if (!open) return fab;

      // 面板打开后不再渲染悬浮按钮：它打开时会变成 ×，拖标题栏时留在原地，
      // 和面板脱节；关闭入口统一用面板头那个 ×。
      return h('div', { style: panelStyle, key: 'panel' }, [
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
            dot(healthy ? C.ok : C.dim),
            h('span', { style: S.title, key: 't' }, 'Remotion Studio'),
            h('span', { style: S.subtitle, key: 's' }, `:${(data && data.port) || '—'}`),
          ]),
          h('button', {
            style: S.close, key: 'x', title: '收起', 'aria-label': '收起',
            onClick: () => setOpen(false),
          }, '×'),
        ]),

        h('div', { style: S.body, key: 'body' }, [
          /* 工程：始终一行，没装/想换都能从这里进 */
          h('div', { key: 'proj', style: S.row }, [
            dot(projectValid ? C.ok : C.dim),
            h('span', { style: S.label }, '工程'),
            h('span', {
              style: {
                ...S.value, flex: '1 1 auto', minWidth: 0,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              },
              title: (data && data.projectRoot) || '',
            }, projectValid ? ((data && data.projectRoot) || '已就绪') : '未安装'),
            h(ActButton, {
              variant: 'port',
              disabled: busy || installing,
              title: projectValid ? '换一个工程目录（会重新下载安装）' : '选择目录并下载工程',
              onClick: () => setShowInstall((v) => !v),
            }, showInstall ? '收起' : (projectValid ? '更换' : '安装')),
          ]),

          /* 安装 / 更换工程：可以直接用已有目录，也可以从 npm 下载 */
          showInstall ? h('div', { key: 'install', style: S.installCard }, [
            h('div', { key: 't', style: S.installTitle }, projectValid ? '更换工程目录' : '安装工程'),
            h('div', { key: 'h', style: S.installHint },
              '选一个本机已有的工程目录直接使用；还没有工程的话，再从 npm 下载一份。'),

            h('div', { key: 'r3', style: S.installRow }, [
              h('span', { style: S.label }, '目录'),
              h('input', {
                type: 'text',
                value: installDir,
                placeholder: '点「选择」挑一个目录',
                style: S.portInput,
                disabled: busy || installing,
                onChange: (e) => setInstallDir(e.target.value),
              }),
              h(ActButton, {
                variant: 'port',
                disabled: busy || picking || installing,
                title: '弹系统文件夹选择框',
                onClick: chooseInstallDir,
              }, picking ? '…' : '选择'),
            ]),

            h('div', { key: 'acts', style: S.actions }, [
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
              }, installing ? '下载安装中…' : '下载并安装'),
            ]),

            picking
              ? h('div', { key: 'pk', style: S.installHint },
                '系统文件夹对话框已弹出（可能被 DSH 窗口挡住，留意任务栏），选好点确定。')
              : null,

            h('div', { key: 'r1', style: S.installRow }, [
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
              },
            }, choice.label))) : null,

            registryChoice === 'custom' ? h('div', { key: 'r2', style: S.installRow }, [
              h('span', { style: S.label }, '地址'),
              h('input', {
                type: 'text',
                value: customRegistry,
                placeholder: 'https://registry.npmjs.org',
                style: S.portInput,
                disabled: busy || installing,
                onChange: (e) => setCustomRegistry(e.target.value),
              }),
            ]) : null,

            installState.status === 'failed'
              ? h('div', { key: 'f', style: S.err }, installState.error || '安装失败，看下方日志')
              : installing
                ? h('div', { key: 'p', style: S.installHint }, '进度见下方日志…')
                : null,
          ]) : null,

          h('div', { style: S.row, key: 'url' }, [
            h('span', { style: S.value }, url || '服务未运行'),
          ]),

          h('div', { style: S.row, key: 'build' }, [
            dot(tone(build.status)),
            h('span', { style: S.label }, '构建'),
            h('span', { style: S.value }, BUILD_TEXT[build.status] || build.status || '—'),
            build.finishedAt
              ? h('span', { style: { color: C.faint, fontSize: 11 } }, ` ${timeText(build.finishedAt)}`)
              : null,
          ]),

          h('div', { style: S.row, key: 'srv' }, [
            dot(tone(server.status === 'external' ? 'running' : server.status)),
            h('span', { style: S.label }, '服务'),
            h('span', { style: S.value }, SERVER_TEXT[server.status] || server.status || '—'),
          ]),

          h('div', { style: S.row, key: 'port' }, [
            h('span', { style: S.label }, '端口'),
            h('input', {
              type: 'number', min: 1024, max: 65535, step: 1,
              value: portDraft,
              style: S.portInput,
              disabled: running,
              'aria-label': '运行端口',
              title: running ? '先停止服务再改端口' : '改完点「应用」，下次启动用这个端口',
              onChange: (e) => setPortDraft(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') { e.preventDefault(); applyPort(); }
              },
            }),
            h(ActButton, {
              variant: 'port',
              disabled: busy || running,
              title: running ? '先停止服务再改端口' : '应用端口，下次启动生效',
              onClick: applyPort,
            }, running ? '运行中' : '应用'),
          ]),

          h('div', { style: S.actions, key: 'acts' }, [
            h(ActButton, {
              key: 'b',
              variant: 'default',
              disabled: buildDisabled,
              title: running ? '服务运行中，先停止再构建' : '重新构建前端（vite build → dist/web）',
              onClick: () => act('/build', '构建'),
            }, buildLabel),
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
          ]),

          error ? h('div', { style: S.err, key: 'err' }, error) : null,

          h('div', {
            key: 'logs', ref: boxRef, style: S.logBox,
          }, logs.length === 0
            ? [h('div', { key: 'empty', style: { color: C.faint } }, '暂无日志')]
            : logs.map((entry) => h('div', {
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
            '构建产物在 dist/web；启动后可在右侧栏「浏览器」输入上面地址。拖动标题栏可移动面板，位置会记住。'),
        ]),
      ]);
    }

    function apply(ctx) {
      clientCtx = ctx;
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
