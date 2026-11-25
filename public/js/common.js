(function () {
  const LANG_KEY = 'composttwin_lang';
  const ADMIN_PW_KEY = 'composttwin_admin_pw';

  function getLang() {
    const saved = localStorage.getItem(LANG_KEY);
    return saved && window.COMPOST_I18N[saved] ? saved : 'fr';
  }

  function t(key, vars = {}) {
    const lang = getLang();
    const dict = window.COMPOST_I18N[lang] || window.COMPOST_I18N.fr;
    let text = dict[key] || window.COMPOST_I18N.fr[key] || key;
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(`{${k}}`, String(v));
    }
    return text;
  }

  function applyTranslations() {
    const lang = getLang();
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';

    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      el.textContent = t(key);
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      el.setAttribute('placeholder', t(key));
    });

    document.querySelectorAll('.lang-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.lang === lang);
    });

    updateAuthUi();
    window.dispatchEvent(new CustomEvent('langChanged', { detail: { lang } }));
  }

  function setLang(lang) {
    if (!window.COMPOST_I18N[lang]) return;
    localStorage.setItem(LANG_KEY, lang);
    applyTranslations();
  }

  function getAdminPassword() {
    return sessionStorage.getItem(ADMIN_PW_KEY) || '';
  }

  function isAdmin() {
    return Boolean(getAdminPassword());
  }

  function setAdminPassword(pw) {
    if (pw) {
      sessionStorage.setItem(ADMIN_PW_KEY, pw);
    } else {
      sessionStorage.removeItem(ADMIN_PW_KEY);
    }
    updateAuthUi();
    window.dispatchEvent(new CustomEvent('adminAuthChanged', { detail: { isAdmin: isAdmin() } }));
  }

  function updateAuthUi() {
    const loggedIn = isAdmin();
    document.body.classList.toggle('is-admin', loggedIn);
    const authBtn = document.getElementById('adminAuthBtn');
    if (authBtn) {
      authBtn.textContent = loggedIn ? t('adminLogout') : t('adminLogin');
      authBtn.classList.toggle('btn-danger', loggedIn);
      authBtn.classList.toggle('btn-secondary', !loggedIn);
    }
  }

  function updateOnlineBadge(lastReadingIso) {
    const badge = document.getElementById('headerStatusBadge');
    const textEl = document.getElementById('headerStatusText');
    if (!badge || !textEl) return;

    const isOnline =
      Boolean(lastReadingIso) &&
      Date.now() - new Date(lastReadingIso).getTime() <= 30000;

    badge.classList.toggle('online', isOnline);
    badge.classList.toggle('offline', !isOnline);
    textEl.textContent = isOnline ? t('statusOnline') : t('statusOffline');
  }

  function formatDateTime(isoString) {
    if (!isoString) return '—';
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return '—';
    const lang = getLang();
    const locale = lang === 'ar' ? 'ar-TN' : lang === 'en' ? 'en-GB' : 'fr-FR';
    return d.toLocaleString(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function setupLogoFallback() {
    const img = document.getElementById('brandLogoImg');
    const fallback = document.getElementById('brandFallback');
    if (!img || !fallback) return;
    img.addEventListener('error', () => {
      img.style.display = 'none';
      fallback.style.display = 'inline-flex';
    });
  }

  function setupAdminModal() {
    const authBtn = document.getElementById('adminAuthBtn');
    const modal = document.getElementById('adminLoginModal');
    const closeBtn = document.getElementById('adminModalClose');
    const form = document.getElementById('adminLoginForm');
    const pwInput = document.getElementById('adminPasswordInput');
    const errorBox = document.getElementById('adminLoginError');

    if (!authBtn || !modal || !form) return;

    authBtn.addEventListener('click', () => {
      if (isAdmin()) {
        setAdminPassword('');
        return;
      }
      errorBox.style.display = 'none';
      pwInput.value = '';
      modal.classList.add('open');
      setTimeout(() => pwInput.focus(), 50);
    });

    if (closeBtn) {
      closeBtn.addEventListener('click', () => modal.classList.remove('open'));
    }

    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('open');
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox.style.display = 'none';
      const pw = pwInput.value;
      if (!pw) return;

      try {
        const res = await fetch('/api/admin/verify', {
          method: 'POST',
          headers: { 'x-admin-password': pw },
        });
        if (!res.ok) {
          errorBox.textContent = t('loginInvalid');
          errorBox.style.display = 'block';
          return;
        }
        setAdminPassword(pw);
        modal.classList.remove('open');
      } catch {
        errorBox.textContent = t('loginInvalid');
        errorBox.style.display = 'block';
      }
    });
  }

  function initCommon() {
    setupLogoFallback();
    setupAdminModal();

    document.querySelectorAll('.lang-btn').forEach((btn) => {
      btn.addEventListener('click', () => setLang(btn.dataset.lang));
    });

    applyTranslations();
  }

  window.CompostCommon = {
    t,
    getLang,
    setLang,
    getAdminPassword,
    isAdmin,
    setAdminPassword,
    updateOnlineBadge,
    formatDateTime,
    applyTranslations,
  };

  document.addEventListener('DOMContentLoaded', initCommon);
})();
