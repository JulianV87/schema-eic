/**
 * Authentification & gestion de session
 *
 * Externalise du <script> inline pour permettre une CSP stricte sans
 * 'unsafe-inline' sur script-src (ZEN BPSW-004/006).
 *
 * Limites assumees tant que cas A (POC, pas de backend SNCF) :
 *  - Cle anon Supabase exposee cote client (lisible par tout visiteur).
 *    Le hash attendu est donc lui aussi lisible : la verification cote
 *    client est donc defensive, pas de la securite reelle.
 *  - Pas de log serveur des tentatives (ZEN-AUTH-004) : impossible sans
 *    backend.
 *  - Hash maison (legacy) conserve en fallback pour ne pas casser l'acces
 *    actuel. La bascule SHA-256 (ZEN-CRYP-001/002) se fait quand le row
 *    "eic_access_hash" dans la table config Supabase est regenere.
 *
 * Cas B (cible) : tout ce bloc est remplace par un appel a un endpoint
 * backend qui valide les credentials contre l'annuaire SNCF / SSO et pose
 * un cookie de session HttpOnly + Secure + SameSite=Strict.
 */
(function () {
  'use strict';

  const SESSION_KEY = 'eic_session';
  const HASH_KEY = 'eic_access_hash';
  const SUPABASE_URL = 'https://fbcwsgqrwolxnqpasbgl.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZiY3dzZ3Fyd29seG5xcGFzYmdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NDM5NDgsImV4cCI6MjA4OTUxOTk0OH0.yxadPWsLZwYbpet9wlYfTxW9Halx-XMV56PvorCKwIU';

  // ZEN-SESS-002 : duree max 8h
  // ZEN-SESS-003 : inactivite max 20 min
  const SESSION_MAX_MS = 8 * 60 * 60 * 1000;
  const SESSION_IDLE_MS = 20 * 60 * 1000;
  const ACTIVITY_THROTTLE_MS = 30 * 1000;

  // ZEN-ENT-005 : refus / troncature des entrees trop longues
  const MAX_USER_LEN = 64;
  const MAX_PASS_LEN = 256;

  function readSession() {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  function writeSession(s) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  function isSessionValid() {
    const s = readSession();
    if (!s) return false;
    const now = Date.now();
    if (typeof s.expires !== 'number' || s.expires <= now) {
      clearSession();
      return false;
    }
    if (typeof s.lastActive === 'number' && (now - s.lastActive) > SESSION_IDLE_MS) {
      clearSession();
      return false;
    }
    return true;
  }

  function showApp() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = '';
  }

  // Restauration de session au chargement
  if (isSessionValid()) {
    // Refresh lastActive
    const s = readSession();
    s.lastActive = Date.now();
    writeSession(s);
    showApp();
  }

  // Timer cote client : verification reguliere de la limite d'inactivite
  setInterval(function () {
    const s = readSession();
    if (!s) return;
    const now = Date.now();
    if (s.expires <= now || (s.lastActive && (now - s.lastActive) > SESSION_IDLE_MS)) {
      clearSession();
      // Rechargement de la page pour repasser par l'ecran de login
      location.reload();
    }
  }, 60 * 1000);

  // Refresh lastActive sur activite utilisateur (throttle 30s)
  let _lastActivityWrite = 0;
  function bumpActivity() {
    const now = Date.now();
    if (now - _lastActivityWrite < ACTIVITY_THROTTLE_MS) return;
    _lastActivityWrite = now;
    const s = readSession();
    if (!s) return;
    s.lastActive = now;
    writeSession(s);
  }
  ['mousedown', 'keydown', 'touchstart', 'wheel'].forEach(function (evt) {
    document.addEventListener(evt, bumpActivity, { passive: true });
  });

  // ZEN-CRYP-001/002 : SHA-256 avec sel par compte
  async function sha256Hex(str) {
    const buf = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
      .map(function (b) { return b.toString(16).padStart(2, '0'); })
      .join('');
  }

  async function modernHash(user, pass) {
    const salt = 'eic-pn-v1-' + user;
    return 'sha256:' + await sha256Hex(salt + ':' + pass);
  }

  // Hash legacy conserve pour compatibilite avec le hash deja stocke
  // dans Supabase. A retirer apres regeneration du row eic_access_hash
  // au format moderne.
  function legacyHash(user, pass) {
    const str = user + ':' + pass;
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return 'h' + Math.abs(h).toString(36);
  }

  function showError(msg) {
    const errEl = document.getElementById('login-error');
    if (msg) errEl.textContent = msg;
    errEl.style.display = 'block';
  }

  async function tryLogin() {
    const userEl = document.getElementById('login-user');
    const passEl = document.getElementById('login-pass');
    const user = userEl.value.trim().toLowerCase();
    const pass = passEl.value.trim();
    if (!user || !pass) return;
    if (user.length > MAX_USER_LEN || pass.length > MAX_PASS_LEN) {
      showError('Identifiant ou mot de passe trop long');
      passEl.value = '';
      return;
    }

    let expected;
    try {
      const resp = await fetch(SUPABASE_URL + '/rest/v1/config?key=eq.' + encodeURIComponent(HASH_KEY) + '&select=value', {
        headers: { apikey: SUPABASE_KEY },
      });
      const rows = await resp.json();
      expected = rows.length > 0 ? rows[0].value : null;
    } catch (e) {
      showError('Connexion Supabase impossible. Verifie le reseau et reessaie.');
      passEl.value = '';
      return;
    }

    if (!expected || !expected.hash) {
      showError();
      passEl.value = '';
      passEl.focus();
      return;
    }

    const candidates = await Promise.all([
      modernHash(user, pass),
      Promise.resolve(legacyHash(user, pass)),
    ]);

    if (candidates.indexOf(expected.hash) !== -1) {
      const now = Date.now();
      writeSession({ expires: now + SESSION_MAX_MS, lastActive: now });
      showApp();
    } else {
      showError();
      passEl.value = '';
      passEl.focus();
    }
  }

  document.getElementById('login-btn').addEventListener('click', tryLogin);
  document.getElementById('login-pass').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') tryLogin();
  });
  document.getElementById('login-user').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('login-pass').focus();
  });

  document.addEventListener('DOMContentLoaded', function () {
    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        if (confirm('Se deconnecter ?')) {
          clearSession();
          location.reload();
        }
      });
    }
  });
})();
