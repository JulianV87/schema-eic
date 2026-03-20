/**
 * Store — Supabase comme source principale, localStorage comme cache offline
 *
 * Toute lecture va d'abord vers Supabase, fallback localStorage.
 * Toute écriture va vers Supabase, puis cache dans localStorage.
 */
const Store = (() => {

  const SUPABASE_URL = 'https://fbcwsgqrwolxnqpasbgl.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZiY3dzZ3Fyd29seG5xcGFzYmdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NDM5NDgsImV4cCI6MjA4OTUxOTk0OH0.yxadPWsLZwYbpet9wlYfTxW9Halx-XMV56PvorCKwIU';

  let online = false;
  let cache = {}; // cache mémoire de toutes les clés

  function headers() {
    return {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    };
  }

  /**
   * Initialiser : charger tout depuis Supabase → cache mémoire + localStorage
   */
  async function init() {
    // D'abord charger le cache localStorage (instantané)
    loadLocalCache();

    // Clés en attente de sync (modifiées localement mais pas encore poussées vers Supabase)
    const pendingKeys = new Set(JSON.parse(localStorage.getItem('_store_pending') || '[]'));

    // Puis tenter Supabase
    try {
      const resp = await fetch(SUPABASE_URL + '/rest/v1/config?select=*', {
        headers: headers(),
      });

      if (resp.ok) {
        online = true;
        const rows = await resp.json();

        if (rows && rows.length > 0) {
          // Supabase a des données — mais ne PAS écraser les clés pending (local est plus frais)
          let loaded = 0;
          let skipped = 0;
          rows.forEach(row => {
            if (pendingKeys.has(row.key)) {
              // Cette clé a été modifiée localement et pas encore synchronisée
              // → garder la version locale (plus récente)
              skipped++;
              return;
            }
            const val = JSON.stringify(row.value);
            cache[row.key] = val;
            localStorage.setItem(row.key, val);
            loaded++;
          });
          console.log(`Store: ${loaded} clés depuis Supabase, ${skipped} clés locales conservées`);

          // Synchroniser les clés en attente vers Supabase
          if (pendingKeys.size > 0) {
            await syncPending();
          }
        } else {
          // Supabase vide → pousser le localStorage actuel
          console.log('Store: base vide, envoi initial...');
          await pushAllToCloud();
        }
        showStatus('ok');
      } else {
        console.warn('Store: Supabase HTTP ' + resp.status);
        showStatus('offline');
      }
    } catch (e) {
      console.warn('Store: hors-ligne —', e.message);
      showStatus('offline');
    }
  }

  /**
   * Charger le localStorage dans le cache mémoire
   */
  function loadLocalCache() {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('eic_')) {
        cache[key] = localStorage.getItem(key);
      }
    }
  }

  /**
   * LIRE une clé — cache mémoire (déjà synchronisé avec Supabase au init)
   */
  function get(key) {
    return cache[key] || localStorage.getItem(key) || null;
  }

  /**
   * ÉCRIRE une clé — Supabase d'abord, puis cache + localStorage
   */
  async function set(key, value) {
    const json = typeof value === 'string' ? value : JSON.stringify(value);
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;

    // 1. Cache mémoire + localStorage immédiat (pour que l'UI réagisse vite)
    cache[key] = json;
    localStorage.setItem(key, json);

    // 2. Marquer comme pending AVANT l'envoi Supabase (protège contre fermeture de page)
    markPending(key);

    // 3. Supabase en background
    if (online) {
      try {
        const resp = await fetch(SUPABASE_URL + '/rest/v1/config', {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify([{ key: key, value: parsed }]),
        });
        if (resp.ok) {
          // Écriture réussie → retirer du pending
          removePending(key);
        } else {
          console.error('Store: erreur écriture', key, resp.status);
          showStatus('error');
        }
      } catch (e) {
        console.warn('Store: écriture offline pour', key);
        showStatus('offline');
      }
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
   * Marquer une clé comme en attente de sync
   */
  function markPending(key) {
    const pending = JSON.parse(localStorage.getItem('_store_pending') || '[]');
    if (!pending.includes(key)) {
      pending.push(key);
      localStorage.setItem('_store_pending', JSON.stringify(pending));
    }
  }

  function removePending(key) {
    const pending = JSON.parse(localStorage.getItem('_store_pending') || '[]');
    const idx = pending.indexOf(key);
    if (idx >= 0) {
      pending.splice(idx, 1);
      localStorage.setItem('_store_pending', JSON.stringify(pending));
    }
  }

  /**
   * Synchroniser les clés en attente (quand on retrouve la connexion)
   */
  async function syncPending() {
    const pending = JSON.parse(localStorage.getItem('_store_pending') || '[]');
    if (pending.length === 0) return;

    const rows = [];
    pending.forEach(key => {
      const val = get(key);
      if (val !== null) {
        try { rows.push({ key: key, value: JSON.parse(val) }); }
        catch { rows.push({ key: key, value: val }); }
      }
    });

    try {
      const resp = await fetch(SUPABASE_URL + '/rest/v1/config', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(rows),
      });
      if (resp.ok) {
        localStorage.setItem('_store_pending', '[]');
        console.log('Store: ' + rows.length + ' clés en attente synchronisées');
        showStatus('ok');
      }
    } catch (e) {
      console.warn('Store: sync pending échouée');
    }
  }

  /**
   * Pousser tout le cache vers Supabase
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
        rows.forEach(row => {
          const val = JSON.stringify(row.value);
          cache[row.key] = val;
          localStorage.setItem(row.key, val);
        });
        showStatus('ok');
        // Aussi sync les pending
        await syncPending();
        return true;
      }
    } catch (e) {
      showStatus('error');
    }
    return false;
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
      offline: ['☁', '#4a6a9a', 'Hors-ligne — clic pour reconnecter'],
      syncing: ['⟳', '#ff9520', 'Synchronisation...'],
      error: ['☁', '#ff4040', 'Erreur — clic pour réessayer'],
    };
    const [icon, color, title] = labels[status] || labels.offline;
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
