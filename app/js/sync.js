/**
 * Store — Supabase comme source UNIQUE
 *
 * Toute lecture/écriture passe par Supabase.
 * Un cache mémoire accélère les lectures après le chargement initial.
 * Plus aucun localStorage.
 */
const Store = (() => {

  const SUPABASE_URL = 'https://fbcwsgqrwolxnqpasbgl.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZiY3dzZ3Fyd29seG5xcGFzYmdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NDM5NDgsImV4cCI6MjA4OTUxOTk0OH0.yxadPWsLZwYbpet9wlYfTxW9Halx-XMV56PvorCKwIU';

  let online = false;
  let cache = {}; // cache mémoire — rempli au init depuis Supabase

  function headers() {
    return {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    };
  }

  /**
   * Initialiser : charger TOUT depuis Supabase → cache mémoire
   */
  async function init() {
    try {
      const resp = await fetch(SUPABASE_URL + '/rest/v1/config?select=*', {
        headers: headers(),
      });

      if (resp.ok) {
        online = true;
        const rows = await resp.json();

        if (rows && rows.length > 0) {
          rows.forEach(row => {
            cache[row.key] = JSON.stringify(row.value);
          });
          console.log('Store: ' + rows.length + ' clés chargées depuis Supabase');
        } else {
          console.log('Store: base Supabase vide');
        }
        showStatus('ok');
      } else {
        console.error('Store: Supabase HTTP ' + resp.status);
        showStatus('error');
      }
    } catch (e) {
      console.error('Store: impossible de contacter Supabase —', e.message);
      showStatus('error');
    }
  }

  /**
   * LIRE une clé — depuis le cache mémoire (chargé depuis Supabase au init)
   */
  function get(key) {
    return cache[key] || null;
  }

  /**
   * ÉCRIRE une clé — Supabase d'abord, puis cache mémoire
   */
  async function set(key, value) {
    const json = typeof value === 'string' ? value : JSON.stringify(value);
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;

    // 1. Cache mémoire immédiat (pour que l'UI réagisse vite)
    cache[key] = json;

    // 2. Écrire vers Supabase
    if (online) {
      try {
        const resp = await fetch(SUPABASE_URL + '/rest/v1/config', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify([{ key: key, value: parsed }]),
        });
        if (!resp.ok) {
          console.error('Store: erreur écriture Supabase', key, resp.status);
          showStatus('error');
        }
      } catch (e) {
        console.error('Store: écriture échouée pour', key, e.message);
        showStatus('error');
      }
    } else {
      console.warn('Store: hors-ligne, écriture perdue pour', key);
      showStatus('error');
    }
  }

  /**
   * Raccourci : lire + parser JSON
   */
  function getJSON(key, defaultValue) {
    const val = get(key);
    if (val === null) return defaultValue;
    try { return JSON.parse(val); } catch { return defaultValue; }
  }

  /**
   * Forcer un rafraîchissement complet depuis Supabase
   */
  async function forceRefresh() {
    showStatus('syncing');
    try {
      const resp = await fetch(SUPABASE_URL + '/rest/v1/config?select=*', {
        headers: headers(),
      });
      if (resp.ok) {
        online = true;
        const rows = await resp.json();
        cache = {};
        rows.forEach(row => {
          cache[row.key] = JSON.stringify(row.value);
        });
        console.log('Store: rafraîchi — ' + rows.length + ' clés');
        showStatus('ok');
        return true;
      }
    } catch (e) {
      showStatus('error');
    }
    return false;
  }

  /**
   * Pousser tout le cache vers Supabase (utile pour migration)
   */
  async function pushAllToCloud() {
    const rows = [];
    Object.keys(cache).forEach(key => {
      if (!key.startsWith('eic_')) return;
      const val = cache[key];
      if (val !== null) {
        try { rows.push({ key: key, value: JSON.parse(val) }); }
        catch { rows.push({ key: key, value: val }); }
      }
    });

    if (rows.length === 0) return;

    try {
      const resp = await fetch(SUPABASE_URL + '/rest/v1/config', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(rows),
      });
      if (resp.ok) {
        console.log('Store: ' + rows.length + ' clés envoyées à Supabase');
      }
    } catch (e) {
      console.error('Store: push all échoué', e);
    }
  }

  /**
   * Indicateur dans le header
   */
  function showStatus(status) {
    let el = document.getElementById('sync-status');
    if (!el) {
      el = document.createElement('span');
      el.id = 'sync-status';
      el.style.cssText = 'font-size:10px;cursor:pointer;margin-left:4px;';
      el.title = 'Base de données Supabase';
      el.addEventListener('click', async () => {
        await forceRefresh();
        location.reload();
      });
      const clockEl = document.getElementById('clock');
      if (clockEl && clockEl.parentNode) {
        clockEl.parentNode.insertBefore(el, clockEl.nextSibling);
      }
    }

    const labels = {
      ok: ['☁', '#00d4a0', 'Connecté à Supabase'],
      syncing: ['⟳', '#ff9520', 'Synchronisation...'],
      error: ['☁', '#ff4040', 'Erreur Supabase — clic pour réessayer'],
    };
    const [icon, color, title] = labels[status] || labels.error;
    el.textContent = icon;
    el.style.color = color;
    el.title = title;
  }

  function isOnline() { return online; }

  // Compatibilité avec l'ancien Sync.save()
  function save(key, value) { return set(key, value); }

  return { init, get, set, getJSON, save, forceRefresh, isOnline, pushAllToCloud };
})();

// Alias pour compatibilité
const Sync = Store;
