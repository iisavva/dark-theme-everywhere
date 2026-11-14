/* Minimal chrome.* stub so the content script can run on a plain page for manual testing. */
(function () {
  const store = {};
  const listeners = [];
  const msgListeners = [];
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  window.chrome = {
    runtime: {
      id: 'stub',
      sendMessage: () => Promise.resolve(null),
      onMessage: { addListener: (f) => msgListeners.push(f) }
    },
    storage: {
      local: {
        get: async (defaults) => {
          const out = {};
          for (const k of Object.keys(defaults)) out[k] = k in store ? clone(store[k]) : clone(defaults[k]);
          return out;
        },
        set: async (obj) => {
          const changes = {};
          for (const k of Object.keys(obj)) {
            changes[k] = { oldValue: clone(store[k]), newValue: clone(obj[k]) };
            store[k] = clone(obj[k]);
          }
          listeners.forEach((f) => f(changes, 'local'));
        }
      },
      onChanged: { addListener: (f) => listeners.push(f) }
    }
  };
  window.__status = () => new Promise((r) => msgListeners.forEach((f) => f({ type: 'getStatus' }, {}, r)));
})();
