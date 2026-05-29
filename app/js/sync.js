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
  const loadedHeavy = new Set(); // clés lourdes déjà chargées à la demande

  // Clés volumineuses (images base64) exclues du chargement initial.
  // Elles sont chargées à la demande via ensureKey() quand l'UI en a besoin,
  // pour éviter de télécharger ~25 Mo à chaque ouverture de page (egress).
  const HEAVY_FILTER =
    '&key=not.like.eic_image_library*&key=not.eq.eic_stickers';

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
      const resp = await fetch(SUPABASE_URL + '/rest/v1/config?select=*' + HEAVY_FILTER, {
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
   * Charger une clé lourde à la demande (images base64) — une seule fois.
   * Les lectures get()/getJSON() qui suivent la trouveront dans le cache.
   */
  async function ensureKey(key) {
    if (loadedHeavy.has(key) || (key in cache)) return;
    loadedHeavy.add(key);
    if (!online) return;
    try {
      const resp = await fetch(
        SUPABASE_URL + '/rest/v1/config?select=value&key=eq.' + encodeURIComponent(key),
        { headers: headers() }
      );
      if (resp.ok) {
        const rows = await resp.json();
        if (rows && rows.length > 0) {
          cache[key] = JSON.stringify(rows[0].value);
        }
      } else {
        loadedHeavy.delete(key); // permettre une nouvelle tentative
      }
    } catch (e) {
      loadedHeavy.delete(key);
      console.warn('Store: ensureKey échoué pour', key, e.message);
    }
  }

  /**
   * Uploader une image (data URL base64) vers Supabase Storage et renvoyer
   * son URL publique. Adressage par hash de contenu (dedup automatique).
   * Si déjà une URL, ou en cas d'échec, renvoie l'entrée telle quelle
   * (fallback base64) pour ne jamais perdre l'image.
   */
  async function uploadImage(dataUrl) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) return dataUrl;
    const sep = dataUrl.indexOf(';base64,');
    if (sep < 0) return dataUrl;
    const mime = dataUrl.slice(5, sep);
    const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' })[mime] || 'png';
    let bytes;
    try {
      const bin = atob(dataUrl.slice(sep + 8));
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
      const hash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
      const objPath = 'stickers/' + hash + '.' + ext;
      const resp = await fetch(SUPABASE_URL + '/storage/v1/object/tiles/' + objPath, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': mime, 'x-upsert': 'true' },
        body: bytes,
      });
      if (resp.ok || resp.status === 409) {
        return SUPABASE_URL + '/storage/v1/object/public/tiles/' + objPath;
      }
      console.error('Store: uploadImage HTTP', resp.status);
    } catch (e) {
      console.error('Store: uploadImage échoué —', e.message);
    }
    return dataUrl; // fallback : conserver la base64 plutôt que perdre l'image
  }

  /**
   * Forcer un rafraîchissement complet depuis Supabase
   */
  async function forceRefresh() {
    showStatus('syncing');
    try {
      const resp = await fetch(SUPABASE_URL + '/rest/v1/config?select=*' + HEAVY_FILTER, {
        headers: headers(),
      });
      if (resp.ok) {
        online = true;
        const rows = await resp.json();
        cache = {};
        loadedHeavy.clear();
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

  return { init, get, set, getJSON, save, forceRefresh, isOnline, pushAllToCloud, ensureKey, uploadImage };
})();

// Alias pour compatibilité
const Sync = Store;
