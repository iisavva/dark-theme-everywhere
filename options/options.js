(async function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let settings = await DT.loadSettings();

  function renderSites() {
    const tbody = $('sites');
    tbody.textContent = '';
    const keys = Object.keys(settings.sites).sort();
    $('empty').hidden = keys.length > 0;
    for (const key of keys) {
      const tr = document.createElement('tr');

      const name = document.createElement('td');
      name.textContent = key === 'file' ? 'Локальные файлы (file://)' : key;

      const stateCell = document.createElement('td');
      const select = document.createElement('select');
      for (const [v, label] of [['on', 'Всегда тёмная'], ['off', 'Никогда не тёмная']]) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        select.appendChild(o);
      }
      select.value = settings.sites[key] ? 'on' : 'off';
      select.addEventListener('change', () => save(DT.sitesWith(settings, key, select.value)));
      stateCell.appendChild(select);

      const delCell = document.createElement('td');
      const del = document.createElement('button');
      del.className = 'del';
      del.type = 'button';
      del.title = 'Удалить правило';
      del.setAttribute('aria-label', 'Удалить правило для ' + key);
      del.textContent = '×';
      del.addEventListener('click', () => save(DT.sitesWith(settings, key, 'default')));
      delCell.appendChild(del);

      tr.append(name, stateCell, delCell);
      tbody.appendChild(tr);
    }
  }

  function render() {
    $('global').checked = !!settings.enabled;
    SettingsForm.fill(settings);
    renderSites();
  }

  function save(sites) {
    return chrome.storage.local.set({ sites });
  }

  $('global').addEventListener('change', (e) => chrome.storage.local.set({ enabled: e.target.checked }));

  $('addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = $('addHost').value;
    const host = /^file:/i.test(raw.trim()) ? 'file' : DT.normalizeHost(raw);
    if (!host || !/^[a-z0-9.-]+$|^file$/i.test(host)) {
      $('addHost').setCustomValidity('Введите домен, например example.com');
      $('addHost').reportValidity();
      return;
    }
    save(DT.sitesWith(settings, host, $('addState').value));
    $('addHost').value = '';
  });
  $('addHost').addEventListener('input', () => $('addHost').setCustomValidity(''));

  $('clearCache').addEventListener('click', async () => {
    await chrome.storage.local.remove('nativeDark');
    $('clearCache').textContent = 'Готово';
    setTimeout(() => { $('clearCache').textContent = 'Забыть найденные тёмные сайты'; }, 1500);
  });

  $('reset').addEventListener('click', async () => {
    if (!confirm('Вернуть настройки по умолчанию? Список сайтов сохранится.')) return;
    const defaults = Object.assign({}, DT.DEFAULTS);
    delete defaults.sites;
    await chrome.storage.local.set(defaults);
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    settings = await DT.loadSettings();
    render();
  });

  SettingsForm.bind();
  render();
})();
