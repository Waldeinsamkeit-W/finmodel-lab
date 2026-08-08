/* ============================================================================
 * save.js —— 统一的「把文件交给用户」通道
 *
 * 普通网页里 a[download] 就够了。但这个页面也会以 claude.ai 制品的形式跑在
 * 带 sandbox 的 iframe 里（sandbox="allow-scripts allow-same-origin allow-forms"，
 * 没有 allow-downloads）——那里浏览器会直接拦掉页面自己发起的下载：不报错、
 * 不下载、什么都不发生。宿主为此给了 window.claude.downloads 通道，走它才会
 * 弹出保存确认框。
 *
 * 所以：有宿主通道就走宿主通道，没有就退回 a[download]。
 * ==========================================================================*/
(function (global) {
  'use strict';
  const Save = {};

  function host() {
    const c = global.claude;
    return (c && c.downloads && typeof c.downloads.save === 'function') ? c.downloads : null;
  }

  /* 是否被嵌在别人的 iframe 里。sandbox 标志没法从内部查询，
     所以这只用来在「嵌着 + 又没有宿主通道」时给一句提示。 */
  function embedded() {
    try { return global.self !== global.top; } catch (e) { return true; }
  }

  Save.channel = function () {
    if (host()) return 'host';
    return embedded() ? 'blocked' : 'anchor';
  };

  /* 宿主对扩展名有白名单，.xlsx 不一定在里面。被拒时补一个允许的后缀再存一次
     ——字节完全一样，用户把文件名改回 .xlsx 就能打开。 */
  const FALLBACK_EXT = '.txt';

  const CODE_MSG = {
    declined: '你取消了保存',
    rate_limited: '刚保存过，稍等一下再点',
    too_large: '文件超过 16 MB，宿主不允许保存',
    bad_request: '文件名或内容不合法',
    unavailable: '当前环境不支持保存文件',
    not_granted: '当前环境未开放保存权限',
    capability_disabled: '当前环境未开放保存权限',
    capability_removed: '保存权限已被收回，刷新页面再试',
    transform_error: '文件内容处理失败'
  };

  function toError(err) {
    const code = err && err.code;
    const e = new Error(CODE_MSG[code] || (err && err.message) || '保存失败');
    e.code = code || 'unknown';
    return e;
  }

  /**
   * 把 Blob 交给用户。返回 Promise<{ filename, size, renamed, original }>。
   * renamed = true 表示宿主不收这个扩展名，已换名保存，需要提示用户改回来。
   */
  Save.file = function (blob, filename) {
    const h = host();
    if (h) {
      /* Blob 会被复制（不像 ArrayBuffer 会被转移），失败后可以直接重试 */
      return h.save({ filename: filename, data: blob })
        .then(function () { return { filename: filename, size: blob.size, renamed: false }; })
        .catch(function (err) {
          const code = err && err.code;
          if (code !== 'rejected_extension' && code !== 'extension_not_enabled') throw toError(err);
          const alt = filename + FALLBACK_EXT;
          return h.save({ filename: alt, data: blob }).then(function () {
            return { filename: alt, size: blob.size, renamed: true, original: filename };
          }).catch(function (e2) { throw toError(e2); });
        });
    }

    if (embedded()) {
      const e = new Error('这个页面被嵌在不允许下载的框架里。请在新标签页单独打开本页，或用本地版本导出。');
      e.code = 'sandboxed';
      return Promise.reject(e);
    }

    return new Promise(function (resolve, reject) {
      try {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
        resolve({ filename: filename, size: blob.size, renamed: false });
      } catch (err) { reject(err); }
    });
  };

  /* 文件名里不能出现的字符 */
  Save.safeName = function (s, max) {
    return String(s).replace(/[\\\/:*?"<>|]/g, '_').trim().slice(0, max || 60) || 'download';
  };

  global.Save = Save;
})(window);
