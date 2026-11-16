/*
 * Binds inputs whose id matches a setting key to chrome.storage: ranges, checkboxes, selects and
 * time inputs. (The language selector is handled by ui/i18n.js.)
 */
(function () {
  'use strict';

  const timers = {};
  const SKIP = new Set(['language']);

  function save(key, value, delay) {
    clearTimeout(timers[key]);
    timers[key] = setTimeout(() => chrome.storage.local.set({ [key]: value }), delay);
  }

  function fill(settings) {
    for (const key of Object.keys(DT.DEFAULTS)) {
      if (SKIP.has(key)) continue;
      const input = document.getElementById(key);
      if (!input || document.activeElement === input) continue;
      if (input.type === 'checkbox') input.checked = !!settings[key];
      else if (input.type === 'range' || input.type === 'time' || input.localName === 'select') input.value = settings[key];
      const out = document.querySelector(`output[data-for="${key}"]`);
      // A range input snaps old values to its step, so show what the slider shows.
      if (out) out.textContent = (input.type === 'range' ? input.value : settings[key]) + '%';
    }
  }

  function bind() {
    for (const key of Object.keys(DT.DEFAULTS)) {
      if (SKIP.has(key)) continue;
      const input = document.getElementById(key);
      if (!input) continue;
      if (input.type === 'checkbox') {
        input.addEventListener('change', () => save(key, input.checked, 0));
      } else if (input.type === 'range') {
        input.addEventListener('input', () => {
          const out = document.querySelector(`output[data-for="${key}"]`);
          if (out) out.textContent = input.value + '%';
          save(key, Number(input.value), 120);
        });
        input.addEventListener('dblclick', () => {
          input.value = DT.DEFAULTS[key];
          input.dispatchEvent(new Event('input'));
        });
      } else if (input.localName === 'select') {
        input.addEventListener('change', () => save(key, input.value, 0));
      } else if (input.type === 'time') {
        input.addEventListener('change', () => { if (DT.parseTime(input.value) !== null) save(key, input.value, 0); });
      }
    }
  }

  window.SettingsForm = { fill, bind };
})();
