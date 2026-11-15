/*
 * Interface languages of the popup, the options page and the toolbar title.
 * English is the default; the language is a setting (`language`), switched in the popup or on the
 * options page. Texts are put in with textContent / setAttribute only, never as HTML.
 *
 *   data-i18n="key"             – the element's text
 *   data-i18n-title="key"       – its title attribute (also -placeholder, -aria-label)
 */
(function (root) {
  'use strict';

  const STR = {
    en: {
      appName: 'Dark Theme',
      appFullName: 'Dark Theme Everywhere',
      optionsTitle: 'Dark Theme — settings',
      language: 'Language',

      allSites: 'All sites',
      allSitesTitle: 'Dark theme for all sites',
      siteGroup: 'Dark theme on this site',
      siteDefault: 'Default',
      siteOn: 'On',
      siteOff: 'Off',

      brightness: 'Brightness',
      contrast: 'Contrast',
      sepia: 'Sepia',
      grayscale: 'Grayscale',
      imageBrightness: 'Image brightness',
      imageBrightnessFull: 'Image and video brightness',

      smartImages: 'Smart handling of images and colours',
      smartImagesHint: 'Dark logos turn light; colour palettes and drawing boards keep their real colours',
      smartImagesHintLong: 'The extension looks at how transparent and bright a picture is and at the ' +
        'background behind it. A black logo on a transparent background, which would vanish on a ' +
        'dark page, turns light; photos stay as they are. Colour palettes (brush colours on online ' +
        'whiteboards, product colours in shops) keep their real colours, and on whiteboards and ' +
        'editors so does the drawing area, so what you draw matches the colour you picked.',
      invertDoc: 'Invert light pictures with text',
      invertDocHint: 'Diagrams, document screenshots, black text on white',
      invertDocHintLong: 'Diagrams, charts, document screenshots: the white background turns dark and ' +
        'the black letters light.',
      detectDark: 'Leave sites that are already dark alone',
      detectDarkHint: 'Otherwise a dark site would turn light after inversion.',

      openOptions: 'Site list and settings',
      keysThisSite: '— this site',

      servicePage: 'Browser page',
      serviceStatus: 'Extensions cannot work on this page.',
      localFiles: 'Local files',
      ruleFor: 'The rule for {host} applies: {state}.',
      stateOn: 'on',
      stateOff: 'off',
      needFileAccess: 'For local files, allow access to file URLs in the extension settings.',
      reloadPage: 'Reload the page to start the extension on it.',
      statusOn: 'Dark theme is on.',
      statusNativeDark: 'The site is already dark, so the theme is not applied. Press “On” to apply it anyway.',
      statusOff: 'Dark theme is off.',

      enableAll: 'Enable for all sites',
      sites: 'Sites',
      sitesHint1: 'A site rule beats the global switch. A rule for ',
      sitesHint2: ' also applies to its subdomains (',
      sitesHint3: ') unless a subdomain has its own rule.',
      alwaysDark: 'Always dark',
      neverDark: 'Never dark',
      add: 'Add',
      colSite: 'Site',
      colTheme: 'Dark theme',
      emptyRules: 'No rules yet. The easiest way to add one is from the extension popup on the site.',
      localFilesRule: 'Local files (file://)',
      deleteRule: 'Delete rule',
      deleteRuleFor: 'Delete the rule for {host}',
      enterDomain: 'Enter a domain, for example example.com',
      colors: 'Colours',
      sliderHint: 'Double-click a slider to reset it to the default.',
      imagesBehaviour: 'Pictures and behaviour',
      clearCache: 'Forget detected dark sites',
      done: 'Done',
      reset: 'Reset settings',
      resetConfirm: 'Restore the default settings? The site list is kept.',
      shortcuts: 'Keyboard shortcuts',
      keysSite: ' — toggle the theme on the current site, ',
      keysAll: ' — for all sites.',
      keysHint1: 'To change them: ',
      keysHint2: ' (Chrome, Edge, Yandex) or “Manage extensions → ⚙ → Manage extension shortcuts” in Firefox.',

      titleOn: 'Dark theme: on',
      titleOff: 'Dark theme: off'
    },

    ru: {
      appName: 'Тёмная тема',
      appFullName: 'Тёмная тема везде',
      optionsTitle: 'Тёмная тема — настройки',
      language: 'Язык',

      allSites: 'Все сайты',
      allSitesTitle: 'Тёмная тема для всех сайтов',
      siteGroup: 'Тёмная тема на этом сайте',
      siteDefault: 'Как везде',
      siteOn: 'Включить',
      siteOff: 'Выключить',

      brightness: 'Яркость',
      contrast: 'Контраст',
      sepia: 'Сепия',
      grayscale: 'Оттенки серого',
      imageBrightness: 'Яркость картинок',
      imageBrightnessFull: 'Яркость картинок и видео',

      smartImages: 'Умная обработка картинок и цветов',
      smartImagesHint: 'Тёмные логотипы становятся светлыми, палитры цветов и доски для рисования — в настоящих цветах',
      smartImagesHintLong: 'Расширение смотрит на прозрачность и яркость картинки и на фон за ней. ' +
        'Чёрный логотип на прозрачном фоне, который пропал бы на тёмной странице, становится светлым; ' +
        'фотографии остаются как есть. Палитры цветов (выбор цвета кисти на онлайн-досках, цвета товара ' +
        'в магазине) показываются в настоящих цветах, а на досках и в редакторах — и область рисования, ' +
        'чтобы нарисованное совпадало с выбранным цветом.',
      invertDoc: 'Инвертировать светлые картинки с текстом',
      invertDocHint: 'Схемы, скриншоты документов, чёрный текст на белом',
      invertDocHintLong: 'Схемы, графики, скриншоты документов — белый фон станет тёмным, чёрные буквы светлыми.',
      detectDark: 'Не трогать сайты, которые уже тёмные',
      detectDarkHint: 'Иначе тёмный сайт после инверсии стал бы светлым.',

      openOptions: 'Список сайтов и настройки',
      keysThisSite: '— этот сайт',

      servicePage: 'Служебная страница',
      serviceStatus: 'Расширения не работают на этой странице.',
      localFiles: 'Локальные файлы',
      ruleFor: 'Действует правило для {host}: {state}.',
      stateOn: 'включено',
      stateOff: 'выключено',
      needFileAccess: 'Для локальных файлов разрешите доступ к URL файлов в настройках расширения.',
      reloadPage: 'Обновите страницу, чтобы расширение начало работать на ней.',
      statusOn: 'Тёмная тема включена.',
      statusNativeDark: 'Сайт уже тёмный — тема не применяется. Нажмите «Включить», чтобы применить принудительно.',
      statusOff: 'Тёмная тема выключена.',

      enableAll: 'Включить для всех сайтов',
      sites: 'Сайты',
      sitesHint1: 'Правило для сайта важнее общего переключателя. Правило для ',
      sitesHint2: ' действует и на его поддомены (',
      sitesHint3: '), если у поддомена нет своего правила.',
      alwaysDark: 'Всегда тёмная',
      neverDark: 'Никогда не тёмная',
      add: 'Добавить',
      colSite: 'Сайт',
      colTheme: 'Тёмная тема',
      emptyRules: 'Правил пока нет. Их удобно добавлять из всплывающего окна расширения на нужном сайте.',
      localFilesRule: 'Локальные файлы (file://)',
      deleteRule: 'Удалить правило',
      deleteRuleFor: 'Удалить правило для {host}',
      enterDomain: 'Введите домен, например example.com',
      colors: 'Цвета',
      sliderHint: 'Двойной щелчок по ползунку возвращает значение по умолчанию.',
      imagesBehaviour: 'Картинки и поведение',
      clearCache: 'Забыть найденные тёмные сайты',
      done: 'Готово',
      reset: 'Сбросить настройки',
      resetConfirm: 'Вернуть настройки по умолчанию? Список сайтов сохранится.',
      shortcuts: 'Горячие клавиши',
      keysSite: ' — переключить тему на текущем сайте, ',
      keysAll: ' — для всех сайтов.',
      keysHint1: 'Изменить сочетания: ',
      keysHint2: ' (Chrome, Edge, Яндекс) или «Управление расширениями → ⚙ → Управление горячими клавишами» в Firefox.',

      titleOn: 'Тёмная тема: включена',
      titleOff: 'Тёмная тема: выключена'
    }
  };

  const LANGUAGES = [['en', 'English'], ['ru', 'Русский']];
  let lang = 'en';

  function setLang(value) {
    lang = Object.prototype.hasOwnProperty.call(STR, value) ? value : 'en';
    return lang;
  }

  function t(key, vars) {
    let s = STR[lang][key];
    if (s === undefined) s = STR.en[key];
    if (s === undefined) return key;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
  }

  /** Puts the texts of the current language into a page. */
  function apply(doc) {
    doc = doc || root.document;
    doc.documentElement.lang = lang;
    doc.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    for (const attr of ['title', 'placeholder', 'aria-label']) {
      doc.querySelectorAll(`[data-i18n-${attr}]`).forEach((el) => {
        el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
      });
    }
  }

  /** Fills a <select> with the languages and keeps the `language` setting in sync with it. */
  function bindSelect(select) {
    select.textContent = '';
    for (const [value, label] of LANGUAGES) {
      const o = root.document.createElement('option');
      o.value = value;
      o.textContent = label;
      select.appendChild(o);
    }
    select.value = lang;
    select.addEventListener('change', () => chrome.storage.local.set({ language: select.value }));
  }

  root.I18N = { STR, LANGUAGES, setLang, t, apply, bindSelect, get lang() { return lang; } };
})(typeof globalThis !== 'undefined' ? globalThis : self);
