(async function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const t = I18N.t;
  let settings = await DT.loadSettings();
  I18N.setLang(settings.language);
  I18N.apply();
  I18N.bindSelect($('language'));
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
    if (I18N.lang !== I18N.setLang(settings.language) || document.documentElement.lang !== I18N.lang) {
      I18N.apply();
      $('language').value = I18N.lang;
    }
    SettingsForm.fill(settings);
    $('global').checked = !!settings.enabled;

    const card = $('siteCard');
    if (!host) {
      $('host').textContent = t('servicePage');
      card.classList.add('disabled');
      $('status').textContent = t('serviceStatus');
      return;
    }
    $('host').textContent = host === 'file' ? t('localFiles') : host;

    const state = siteState();
    for (const b of $('siteSeg').querySelectorAll('button')) {
      const on = b.dataset.v === state;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    }

    const lines = [];
    const ov = DT.findOverride(settings, host);
    if (ov && ov.key !== DT.normalizeHost(host)) {
      lines.push(t('ruleFor', { host: ov.key, state: t(ov.value ? 'stateOn' : 'stateOff') }));
    }
    if (!status || !status.ready) {
      lines.push(t(host === 'file' ? 'needFileAccess' : 'reloadPage'));
    } else if (status.active) {
      lines.push(t('statusOn'));
    } else if (status.siteTheme) {
      lines.push(t('statusSiteTheme'));
    } else if (status.scheduleOff) {
      lines.push(t('statusSchedule'));
    } else if (status.nativeDark && DT.isEnabledFor(settings, host) && settings.detectDarkSites) {
      lines.push(t('statusNativeDark'));
    } else {
      lines.push(t('statusOff'));
    }
    $('status').textContent = lines.join(' ');
    $('status').classList.toggle('on', !!(status && (status.active || status.siteTheme)));

    const n = DT.exclusionsFor(settings, host).length;
    $('excl').hidden = !n;
    $('exclText').textContent = t('excludedCount', { n });
  }

  $('global').addEventListener('change', (e) => chrome.storage.local.set({ enabled: e.target.checked }));

  $('siteSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !host) return;
    chrome.storage.local.set({ sites: DT.sitesWith(settings, host, b.dataset.v) });
  });

  $('pick').addEventListener('click', async () => {
    if (!host || !tab) return;
    let r = null;
    try { r = await chrome.tabs.sendMessage(tab.id, { type: 'pickElement' }, { frameId: 0 }); } catch (e) { r = null; }
    if (r && r.ok) window.close(); // the page shows the picker now
    else $('status').textContent = t('reloadPage');
  });

  $('exclClear').addEventListener('click', () => {
    if (!host) return;
    const all = Object.assign({}, settings.exclusions || {});
    delete all[DT.normalizeHost(host)];
    chrome.storage.local.set({ exclusions: all });
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
