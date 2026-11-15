(async function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const t = I18N.t;
  let settings = await DT.loadSettings();
  I18N.setLang(settings.language);
  I18N.apply();
  I18N.bindSelect($('language'));

  function renderSites() {
    const tbody = $('sites');
    tbody.textContent = '';
    const keys = Object.keys(settings.sites).sort();
    $('empty').hidden = keys.length > 0;
    for (const key of keys) {
      const tr = document.createElement('tr');

      const name = document.createElement('td');
      name.textContent = key === 'file' ? t('localFilesRule') : key;

      const stateCell = document.createElement('td');
      const select = document.createElement('select');
      for (const [v, label] of [['on', t('alwaysDark')], ['off', t('neverDark')]]) {
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
      del.title = t('deleteRule');
      del.setAttribute('aria-label', t('deleteRuleFor', { host: key }));
      del.textContent = '×';
      del.addEventListener('click', () => save(DT.sitesWith(settings, key, 'default')));
      delCell.appendChild(del);

      tr.append(name, stateCell, delCell);
      tbody.appendChild(tr);
    }
  }

  function render() {
    if (I18N.lang !== I18N.setLang(settings.language)) {
      I18N.apply();
      $('language').value = I18N.lang;
    }
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
      $('addHost').setCustomValidity(t('enterDomain'));
      $('addHost').reportValidity();
      return;
    }
    save(DT.sitesWith(settings, host, $('addState').value));
    $('addHost').value = '';
  });
  $('addHost').addEventListener('input', () => $('addHost').setCustomValidity(''));

  $('clearCache').addEventListener('click', async () => {
    await chrome.storage.local.remove('nativeDark');
    $('clearCache').textContent = t('done');
    setTimeout(() => { $('clearCache').textContent = t('clearCache'); }, 1500);
  });

  $('reset').addEventListener('click', async () => {
    if (!confirm(t('resetConfirm'))) return;
    const defaults = Object.assign({}, DT.DEFAULTS);
    delete defaults.sites;
    delete defaults.language; // the chosen interface language stays
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
