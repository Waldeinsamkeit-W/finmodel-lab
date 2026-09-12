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
  /* 最近一次落盘的结果。界面上的「已保存」必须由它驱动，
     以前是写不写得进去都显示已保存——隐私模式、配额满、存储被禁用，
     用户看着绿点做了两小时，关掉全没了。 */
  const saveState = { ok: true, err: null, at: 0 };
  const listeners = [];
  function notify() { listeners.forEach(function (fn) { try { fn(saveState); } catch (e) { /* 监听者自己的错 */ } }); }

  function flush() {
    try {
      global.localStorage.setItem(KEY, JSON.stringify(state));
      saveState.ok = true; saveState.err = null; saveState.at = nowTs();
    } catch (e) {
      saveState.ok = false;
      saveState.err = (e && e.name === 'QuotaExceededError') ? '浏览器存储空间已满'
        : '浏览器不允许写入存储（隐私模式或已禁用）';
      saveState.at = nowTs();
      console.warn('进度保存失败', e);
    }
    notify();
    return saveState.ok;
  }
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveTimer = null; flush(); }, 250);
  }

  function modelRec(id) {
    const st = load();
    if (!st.models[id]) {
      st.models[id] = {
        inputs: {}, startedAt: nowTs(), updatedAt: nowTs(), lastCell: null, lastSheet: 0,
        correct: 0, total: 0, revealed: {}, hints: {}, attempts: {}, firstOk: {},
        snapshots: [], seconds: 0
      };
    }
    const r = st.models[id];
    if (!r.revealed) r.revealed = {};
    /* 下面三项是后加的，老存档里没有——必须补齐，否则读取时会炸 */
    if (!r.hints) r.hints = {};        // key -> 用过的最高提示层级 1|2|3
    if (!r.attempts) r.attempts = {};  // key -> 提交过多少个不同的写法
    if (!r.firstOk) r.firstOk = {};    // key -> 1/0，第一次提交是否就对了（只记一次）
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

    /* ------------------------------------------------------------------
     * 提示与尝试的记录
     *
     * 这三个函数是「独立掌握度」的全部数据来源。以前只有 revealed 一个标记，
     * 而且它只在「填入参考公式」时才置位——学员从侧栏看到完整公式再自己敲一遍，
     * 系统完全不知道，进度照样算 100%。那让完成度这个数字失去了意义。
     * ---------------------------------------------------------------- */

    /** 记录用过的提示层级，只升不降 */
    markHint: function (modelId, key, tier) {
      const r = modelRec(modelId);
      const cur = r.hints[key] || 0;
      if (tier > cur) { r.hints[key] = tier; r.updatedAt = nowTs(); scheduleSave(); }
    },

    /** 提交一次作答。返回这是第几次尝试。 */
    bumpAttempt: function (modelId, key) {
      const r = modelRec(modelId);
      r.attempts[key] = (r.attempts[key] || 0) + 1;
      scheduleSave();
      return r.attempts[key];
    },

    /** 第一次判定结果，只记一次——之后再改再对都不算「首次正确」 */
    markFirstResult: function (modelId, key, ok) {
      const r = modelRec(modelId);
      if (r.firstOk[key] === undefined) { r.firstOk[key] = ok ? 1 : 0; scheduleSave(); }
    },

    /** 这一格是不是「独立完成」：没看过答案，也没用过 2 级以上的提示 */
    isSolo: function (modelId, key) {
      const r = load().models[modelId];
      if (!r) return true;
      if (r.revealed && r.revealed[key]) return false;
      return !(r.hints && r.hints[key] >= 2);
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
    /* 快照要存完整的学习记录，不只是作答。以前只存 inputs，恢复之后作答回来了、
       提示和尝试记录却还是清空后的——统计口径就对不上了。 */
    snapshot: function (modelId, note) {
      const r = modelRec(modelId);
      const cp = function (o) { return JSON.parse(JSON.stringify(o || {})); };
      r.snapshots.unshift({
        ts: nowTs(), note: note || '自动存档',
        inputs: cp(r.inputs), revealed: cp(r.revealed), hints: cp(r.hints),
        attempts: cp(r.attempts), firstOk: cp(r.firstOk),
        correct: r.correct, total: r.total
      });
      if (r.snapshots.length > MAX_SNAPSHOTS) r.snapshots.length = MAX_SNAPSHOTS;
      scheduleSave();
    },

    restore: function (modelId, idx) {
      const r = modelRec(modelId);
      const s = r.snapshots[idx];
      if (!s) return false;
      const cp = function (o) { return JSON.parse(JSON.stringify(o || {})); };
      r.inputs = cp(s.inputs);
      /* 老快照没有这几项，恢复成空而不是保留当前值——否则会把两次练习混在一起 */
      r.revealed = cp(s.revealed); r.hints = cp(s.hints);
      r.attempts = cp(s.attempts); r.firstOk = cp(s.firstOk);
      r.correct = s.correct || 0;
      r.updatedAt = nowTs();
      scheduleSave();
      return true;
    },

    /* 重置 = 重新练习。作答、看答案、提示、尝试、首次正确全部归零——
       以前只清前三项，提示记录留着，重做一遍时独立掌握度还带着上次的扣分。 */
    resetModel: function (modelId) {
      const r = modelRec(modelId);
      Store.snapshot(modelId, '重置前自动存档');
      r.inputs = {}; r.revealed = {}; r.hints = {}; r.attempts = {}; r.firstOk = {};
      r.correct = 0;
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

    /* 导入 = 先在副本上完成全部校验和补齐，确认没问题才替换内存与存储。
       以前只查一层 obj.models 就 state = obj 然后 flush()——
       一个 {"models":{"x":null}} 就能通过，把旧存档覆盖掉，
       然后 summary() 读 null.inputs 才炸，界面报「导入失败」但存档已经没了。 */
    importJSON: function (text) {
      let obj;
      try { obj = JSON.parse(text); } catch (e) { throw new Error('不是合法的 JSON 文件'); }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('文件格式不对：顶层不是对象');
      if (!obj.models || typeof obj.models !== 'object' || Array.isArray(obj.models)) throw new Error('文件格式不对：缺少 models');
      if (obj.version !== undefined && obj.version !== 1) throw new Error('备份版本 ' + obj.version + ' 不支持（当前为 1）');

      /* 在副本上逐条校验并补齐字段，任何一条不合法就整体拒绝 */
      const next = emptyState();
      if (obj.prefs && typeof obj.prefs === 'object') next.prefs = obj.prefs;
      if (typeof obj.createdAt === 'number') next.createdAt = obj.createdAt;
      const isObj = function (x) { return x && typeof x === 'object' && !Array.isArray(x); };
      const ids = Object.keys(obj.models);
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i], r = obj.models[id];
        if (!isObj(r)) throw new Error('模型「' + id + '」的记录不是对象');
        if (r.inputs !== undefined && !isObj(r.inputs)) throw new Error('模型「' + id + '」的 inputs 不合法');
        const rec = {
          inputs: {}, startedAt: typeof r.startedAt === 'number' ? r.startedAt : nowTs(),
          updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : nowTs(),
          lastCell: typeof r.lastCell === 'string' ? r.lastCell : null,
          lastSheet: typeof r.lastSheet === 'number' ? r.lastSheet : 0,
          correct: 0, total: 0,
          revealed: isObj(r.revealed) ? r.revealed : {},
          hints: isObj(r.hints) ? r.hints : {},
          attempts: isObj(r.attempts) ? r.attempts : {},
          firstOk: isObj(r.firstOk) ? r.firstOk : {},
          snapshots: Array.isArray(r.snapshots) ? r.snapshots.filter(isObj) : [],
          seconds: typeof r.seconds === 'number' ? r.seconds : 0
        };
        /* inputs 的值只收字符串；别的类型丢掉而不是带进来炸公式引擎 */
        const ks = Object.keys(r.inputs || {});
        for (let k = 0; k < ks.length; k++) {
          const v = r.inputs[ks[k]];
          if (typeof v === 'string' && v !== '') rec.inputs[ks[k]] = v;
        }
        /* 不信任备份里的 correct/total——完成度由 grader 按现在的判定规则重算 */
        next.models[id] = rec;
      }
      next.updatedAt = nowTs();

      /* 走到这里才碰真实状态。先留一份恢复副本再替换。 */
      const before = JSON.stringify(state);
      state = next;
      if (!flush()) {
        state = JSON.parse(before);
        throw new Error('导入内容合法，但写入浏览器存储失败：' + (saveState.err || '未知原因') + '。旧存档未被改动。');
      }
      return { models: ids.length };
    },

    clearAll: function () { state = emptyState(); flush(); },

    flush: flush,
    saveState: function () { return saveState; },
    onSave: function (fn) { if (typeof fn === 'function') listeners.push(fn); }
  };

  /* 页面关闭前强制落盘 */
  global.addEventListener('beforeunload', function () { if (saveTimer) { clearTimeout(saveTimer); flush(); } });

  global.Store = Store;
})(window);
