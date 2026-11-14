(async function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let settings = await DT.loadSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const host = tab ? DT.hostFromUrl(tab.url) : null;
  let status = null;

  async function fetchStatus() {
    if (!host || !tab) return null;
    try {
      return await chrome.tabs.sendMessage(tab.id, { type: 'getStatus' }, { frameId: 0 });
    } catch (e) {
      return null;
    }
  }

  function siteState() {
    if (!host) return null;
    const v = settings.sites[DT.normalizeHost(host)];
    return v === true ? 'on' : v === false ? 'off' : 'default';
  }

  function render() {
    SettingsForm.fill(settings);
    $('global').checked = !!settings.enabled;

    const card = $('siteCard');
    if (!host) {
      $('host').textContent = 'Служебная страница';
      card.classList.add('disabled');
      $('status').textContent = 'Расширения не работают на этой странице.';
      return;
    }
    $('host').textContent = host === 'file' ? 'Локальные файлы' : host;

    const state = siteState();
    for (const b of $('siteSeg').querySelectorAll('button')) {
      const on = b.dataset.v === state;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    }

    const lines = [];
    const ov = DT.findOverride(settings, host);
    if (ov && ov.key !== DT.normalizeHost(host)) {
      lines.push(`Действует правило для ${ov.key}: ${ov.value ? 'включено' : 'выключено'}.`);
    }
    if (!status || !status.ready) {
      lines.push(host === 'file'
        ? 'Для локальных файлов разрешите доступ к URL файлов в настройках расширения.'
        : 'Обновите страницу, чтобы расширение начало работать на ней.');
    } else if (status.active) {
      lines.push('Тёмная тема включена.');
    } else if (status.nativeDark && DT.isEnabledFor(settings, host) && settings.detectDarkSites) {
      lines.push('Сайт уже тёмный — тема не применяется. Нажмите «Включить», чтобы применить принудительно.');
    } else {
      lines.push('Тёмная тема выключена.');
    }
    $('status').textContent = lines.join(' ');
    $('status').classList.toggle('on', !!(status && status.active));
  }

  $('global').addEventListener('change', (e) => chrome.storage.local.set({ enabled: e.target.checked }));

  $('siteSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !host) return;
    chrome.storage.local.set({ sites: DT.sitesWith(settings, host, b.dataset.v) });
  });

  $('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
    window.close();
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    settings = await DT.loadSettings();
    render();
    // Give the page a moment to apply the change, then refresh its status.
    setTimeout(async () => { status = await fetchStatus(); render(); }, 150);
  });

  SettingsForm.bind();
  render();
  status = await fetchStatus();
  render();
})();
