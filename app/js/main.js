/**
 * Point d'entrée — orchestration de l'application
 */
(function main() {
  'use strict';

  // Vérifier que les tuiles existent
  const TILES_PATH = '/tiles/schema.dzi';

  // Fallback : si pas de tuiles, utiliser une image simple
  const FALLBACK_IMAGE = '/tiles/schema_preview.png';

  async function checkTilesComplete() {
    try {
      // Vérifier que le DZI existe ET qu'au moins une tuile du niveau 0 existe
      const dziResp = await fetch(TILES_PATH, { method: 'HEAD' });
      if (!dziResp.ok) return false;
      const tileResp = await fetch('/tiles/schema_files/0/0_0.jpeg', { method: 'HEAD' });
      return tileResp.ok;
    } catch {
      return false;
    }
  }

  async function start() {
    // Synchroniser avec Supabase (charge les données cloud → localStorage)
    try {
      await Sync.init();
    } catch (e) {
      console.warn('Sync init:', e.message);
    }

    // Charger les données (extraites + manuelles)
    try {
      await Data.loadData();
    } catch (e) {
      console.error('Erreur chargement données:', e);
    }
    Parser.init(Data.getGares());

    // Déterminer la source : tuiles complètes > PNG fallback > message d'erreur
    const tilesComplete = await checkTilesComplete();

    let tileSource;
    if (tilesComplete) {
      tileSource = TILES_PATH;
      console.log('Mode: tuiles Deep Zoom');
    } else {
      // Tenter l'image PNG simple
      try {
        const resp = await fetch(FALLBACK_IMAGE, { method: 'HEAD' });
        if (resp.ok) {
          tileSource = { type: 'image', url: FALLBACK_IMAGE };
          console.log('Mode: image PNG (tuiles en cours de génération)');
        } else {
          showSetupMessage();
          return;
        }
      } catch {
        showSetupMessage();
        return;
      }
    }

    // Initialiser le viewer
    Viewer.init(tileSource);

    // Attendre que le viewer soit prêt
    const viewer = Viewer.getMainViewer();
    const onReady = () => {
      Annotations.init();
      Annotations.setupImageLibrary();
      Annotations.setupLegend();
      Search.init();
      Export.init();
      MagicWand.init();
      Calibrate.init();
      Settings.init();
      // Charger la première zone disponible
      const zones = Data.getZones();
      if (zones.length > 0) {
        Viewer.showZone(zones[0].id);
      }
      console.log('EIC Paris Nord — Schéma de Situation — Prêt');
    };

    // Gérer la race condition : le viewer peut déjà être ouvert
    if (viewer.isOpen()) {
      onReady();
    } else {
      viewer.addHandler('open', onReady);
    }
  }

  function showSetupMessage() {
    const container = document.getElementById('osd-viewer');
    if (!container) return;
    container.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#4a6a9a;font-family:'JetBrains Mono',monospace;text-align:center;padding:40px;">
        <div style="font-size:48px;margin-bottom:16px;">📐</div>
        <div style="font-size:16px;color:#c8daf5;margin-bottom:12px;">Tuiles non générées</div>
        <div style="font-size:12px;line-height:1.8;max-width:500px;">
          Pour démarrer, exécutez le script de génération des tuiles :<br><br>
          <code style="background:#111a2e;padding:8px 16px;border-radius:4px;display:inline-block;color:#00d4a0;">
            node scripts/generate_tiles.js
          </code><br><br>
          Ce script convertit le PDF du schéma EIC en tuiles Deep Zoom<br>
          compatibles avec OpenSeadragon.
        </div>
      </div>
    `;
  }

  // Horloge temps réel
  function startClock() {
    const clockEl = document.getElementById('clock');
    if (!clockEl) return;
    const update = () => {
      const now = new Date();
      clockEl.textContent = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    };
    update();
    setInterval(update, 1000);
  }

  // Chronomètre d'incident
  function setupChrono() {
    const btn = document.getElementById('btn-chrono');
    const chronoEl = document.getElementById('chrono');
    if (!btn || !chronoEl) return;

    let startTime = null;
    let intervalId = null;

    btn.addEventListener('click', () => {
      if (startTime === null) {
        // Démarrer
        startTime = Date.now();
        btn.textContent = 'Stop';
        btn.classList.add('active');
        chronoEl.classList.remove('hidden');
        intervalId = setInterval(() => {
          const elapsed = Date.now() - startTime;
          const mins = Math.floor(elapsed / 60000);
          const secs = Math.floor((elapsed % 60000) / 1000);
          chronoEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        }, 1000);
      } else {
        // Arrêter
        clearInterval(intervalId);
        startTime = null;
        btn.textContent = 'Chrono';
        btn.classList.remove('active');
        chronoEl.classList.add('hidden');
      }
    });
  }

  // Démarrer
  startClock();
  setupChrono();
  start();
})();
