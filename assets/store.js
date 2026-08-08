/* ============================================================================
 * store.js —— 学习进度与「最后一次更改」记录
 * 全部存在浏览器 localStorage，支持导出 / 导入 JSON 备份。
 * ==========================================================================*/
(function (global) {
  'use strict';

  const KEY = 'finmodel-lab.v1';
  const MAX_SNAPSHOTS = 12;

  function nowTs() { return Date.now(); }

  function emptyState() {
    return { version: 1, createdAt: nowTs(), updatedAt: nowTs(), last: null, models: {}, prefs: { theme: 'auto' } };
  }

  let state = null;

  function load() {
    if (state) return state;
    try {
      const raw = global.localStorage.getItem(KEY);
      state = raw ? JSON.parse(raw) : emptyState();
      if (!state || typeof state !== 'object' || !state.models) state = emptyState();
      if (!state.prefs) state.prefs = { theme: 'auto' };
    } catch (e) {
      state = emptyState();
    }
    return state;
  }

  let saveTimer = null;
  function flush() {
    try { global.localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { console.warn('进度保存失败（可能是浏览器隐私模式）', e); }
  }
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveTimer = null; flush(); }, 250);
  }

  function modelRec(id) {
    const st = load();
    if (!st.models[id]) {
      st.models[id] = { inputs: {}, startedAt: nowTs(), updatedAt: nowTs(), lastCell: null, lastSheet: 0, correct: 0, total: 0, revealed: {}, snapshots: [], seconds: 0 };
    }
    const r = st.models[id];
    if (!r.revealed) r.revealed = {};
    if (!r.snapshots) r.snapshots = [];
    if (!r.inputs) r.inputs = {};
    return r;
  }

  const Store = {
    all: function () { return load(); },

    prefs: function () { return load().prefs; },
    setPref: function (k, v) { load().prefs[k] = v; scheduleSave(); },

    model: function (id) { return modelRec(id); },

    /** 只读查询，不会创建空记录（列表页渲染用这个） */
    peek: function (id) { return load().models[id] || null; },

    /** 是否真正作答过 */
    hasWork: function (id) {
      const r = load().models[id];
      return !!(r && r.inputs && Object.keys(r.inputs).length > 0);
    },

    /** 记录一次单元格改动 —— 这是「最后一次更改」的核心 */
    setInput: function (modelId, key, raw, meta) {
      const r = modelRec(modelId);
      if (raw === '' || raw === null || raw === undefined) delete r.inputs[key];
      else r.inputs[key] = String(raw);
      r.updatedAt = nowTs();
      r.lastCell = key;
      if (meta && typeof meta.sheet === 'number') r.lastSheet = meta.sheet;
      const st = load();
      st.updatedAt = r.updatedAt;
      st.last = { modelId: modelId, cell: key, sheet: r.lastSheet, ts: r.updatedAt };
      scheduleSave();
    },

    setProgress: function (modelId, correct, total) {
      const r = modelRec(modelId);
      r.correct = correct; r.total = total;
      r.updatedAt = nowTs();
      scheduleSave();
    },

    markRevealed: function (modelId, key) {
      const r = modelRec(modelId);
      r.revealed[key] = 1;
      scheduleSave();
    },

    touch: function (modelId, sheetIdx) {
      const r = modelRec(modelId);
      r.updatedAt = nowTs();
      if (typeof sheetIdx === 'number') r.lastSheet = sheetIdx;
      const st = load();
      st.last = { modelId: modelId, cell: r.lastCell, sheet: r.lastSheet, ts: r.updatedAt };
      st.updatedAt = r.updatedAt;
      scheduleSave();
    },

    addSeconds: function (modelId, sec) {
      const r = modelRec(modelId);
      r.seconds = (r.seconds || 0) + sec;
      scheduleSave();
    },

    /** 存一个还原点，便于回到上一次的状态 */
    snapshot: function (modelId, note) {
      const r = modelRec(modelId);
      r.snapshots.unshift({ ts: nowTs(), note: note || '自动存档', inputs: JSON.parse(JSON.stringify(r.inputs)), correct: r.correct, total: r.total });
      if (r.snapshots.length > MAX_SNAPSHOTS) r.snapshots.length = MAX_SNAPSHOTS;
      scheduleSave();
    },

    restore: function (modelId, idx) {
      const r = modelRec(modelId);
      const s = r.snapshots[idx];
      if (!s) return false;
      r.inputs = JSON.parse(JSON.stringify(s.inputs));
      r.updatedAt = nowTs();
      scheduleSave();
      return true;
    },

    resetModel: function (modelId) {
      const r = modelRec(modelId);
      Store.snapshot(modelId, '清空前自动存档');
      r.inputs = {}; r.revealed = {}; r.correct = 0;
      r.updatedAt = nowTs();
      scheduleSave();
    },

    last: function () { return load().last; },

    /** 全站汇总 */
    summary: function () {
      const st = load();
      let done = 0, started = 0, cells = 0, totalCells = 0, seconds = 0;
      Object.keys(st.models).forEach(function (id) {
        const m = st.models[id];
        const has = Object.keys(m.inputs || {}).length > 0;
        if (has) started++;
        if (m.total > 0 && m.correct >= m.total) done++;
        cells += m.correct || 0;
        totalCells += m.total || 0;
        seconds += m.seconds || 0;
      });
      return { started: started, completed: done, correctCells: cells, totalCells: totalCells, seconds: seconds };
    },

    exportJSON: function () { return JSON.stringify(load(), null, 2); },

    importJSON: function (text) {
      const obj = JSON.parse(text);
      if (!obj || !obj.models) throw new Error('文件格式不对');
      state = obj;
      if (!state.prefs) state.prefs = { theme: 'auto' };
      flush();
      return true;
    },

    clearAll: function () { state = emptyState(); flush(); },

    flush: flush
  };

  /* 页面关闭前强制落盘 */
  global.addEventListener('beforeunload', function () { if (saveTimer) { clearTimeout(saveTimer); flush(); } });

  global.Store = Store;
})(window);
