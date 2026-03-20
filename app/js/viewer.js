/**
 * Viewer OpenSeadragon — gestion du schéma principal et du zoom flottant
 */
const Viewer = (() => {
  let mainViewer = null;
  let zoomViewer = null;
  let currentZone = null;

  function init(tileSource) {
    // Cloner le tileSource pour le 2ème viewer (éviter mutations partagées)
    const zoomTileSource = typeof tileSource === 'string'
      ? tileSource
      : JSON.parse(JSON.stringify(tileSource));

    // Viewer principal
    mainViewer = OpenSeadragon({
      id: 'osd-viewer',
      tileSources: tileSource,
      prefixUrl: 'https://cdn.jsdelivr.net/npm/openseadragon@4.1.1/build/openseadragon/images/',
      drawerType: 'canvas',
      crossOriginPolicy: 'Anonymous',
      showNavigator: true,
      navigatorPosition: 'BOTTOM_LEFT',
      navigatorSizeRatio: 0.15,
      animationTime: 0.3,
      blendTime: 0.1,
      minZoomPixelRatio: 0.5,
      maxZoomPixelRatio: 10,
      visibilityRatio: 0.5,
      constrainDuringPan: false,
      showZoomControl: false,
      showHomeControl: false,
      showFullPageControl: false,
      showRotationControl: false,
      gestureSettingsMouse: {
        scrollToZoom: true,
        clickToZoom: false,
        dblClickToZoom: true,
      },
    });

    // Viewer zoom flottant
    zoomViewer = OpenSeadragon({
      id: 'zoom-popup-viewer',
      tileSources: zoomTileSource,
      prefixUrl: 'https://cdn.jsdelivr.net/npm/openseadragon@4.1.1/build/openseadragon/images/',
      drawerType: 'canvas',
      crossOriginPolicy: 'Anonymous',
      showNavigator: false,
      showZoomControl: false,
      showHomeControl: false,
      showFullPageControl: false,
      showRotationControl: false,
      animationTime: 0.2,
      gestureSettingsMouse: {
        scrollToZoom: true,
        clickToZoom: false,
        dblClickToZoom: true,
      },
    });

    setupZoomPopup();
    setupOverlayCanvas();
    setupZoomControls();

    return mainViewer;
  }

  /**
   * Canvas overlay pour les annotations custom
   * Synchronisé avec le viewport OpenSeadragon
   */
  function setupOverlayCanvas() {
    const container = document.getElementById('viewer-container');

    const canvas = document.createElement('canvas');
    canvas.id = 'annotation-canvas';
    canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;';
    container.appendChild(canvas);

    // Resync le canvas à chaque changement de viewport
    const resizeCanvas = () => {
      canvas.width = container.offsetWidth;
      canvas.height = container.offsetHeight;
      Annotations.redraw();
    };

    mainViewer.addHandler('animation', resizeCanvas);
    mainViewer.addHandler('resize', resizeCanvas);
    window.addEventListener('resize', resizeCanvas);

    // Premier sizing
    mainViewer.addHandler('open', () => {
      setTimeout(resizeCanvas, 100);
    });
  }

  /**
   * Boutons de zoom + indicateur de pourcentage
   */
  function setupZoomControls() {
    const zoomInBtn = document.getElementById('zoom-in');
    const zoomOutBtn = document.getElementById('zoom-out');
    const zoomFitBtn = document.getElementById('zoom-fit');
    const zoomLevel = document.getElementById('zoom-level');

    if (!zoomInBtn || !zoomOutBtn || !zoomFitBtn || !zoomLevel) return;

    let homeZoom = null;

    // Stocker le zoom initial comme référence 100% et restaurer la vue par défaut
    mainViewer.addHandler('open', () => {
      homeZoom = mainViewer.viewport.getHomeZoom();
      // Restaurer la vue par défaut sauvegardée
      const defaultView = Store.getJSON('eic_default_view', null);
      if (defaultView) {
        mainViewer.viewport.panTo(new OpenSeadragon.Point(defaultView.x, defaultView.y), true);
        mainViewer.viewport.zoomTo(defaultView.zoom, null, true);
      }
      updateZoomLevel();
    });

    zoomInBtn.addEventListener('click', () => {
      const current = mainViewer.viewport.getZoom();
      mainViewer.viewport.zoomTo(current * 1.5);
    });

    zoomOutBtn.addEventListener('click', () => {
      const current = mainViewer.viewport.getZoom();
      mainViewer.viewport.zoomTo(current / 1.5);
    });

    zoomFitBtn.addEventListener('click', () => {
      // Restaurer la vue par défaut si elle existe, sinon goHome
      const defaultView = Store.getJSON('eic_default_view', null);
      if (defaultView) {
        mainViewer.viewport.panTo(new OpenSeadragon.Point(defaultView.x, defaultView.y), false);
        mainViewer.viewport.zoomTo(defaultView.zoom, null, false);
      } else {
        mainViewer.viewport.goHome();
      }
    });

    // Clic droit sur Fit → sauvegarder la vue actuelle comme vue par défaut
    zoomFitBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      saveDefaultView();
      zoomFitBtn.textContent = '✓';
      zoomFitBtn.title = 'Vue par défaut sauvegardée';
      setTimeout(() => { zoomFitBtn.textContent = '⟲'; zoomFitBtn.title = 'Vue par défaut (clic droit = sauvegarder)'; }, 1500);
    });

    // Mettre à jour le pourcentage à chaque changement de zoom
    mainViewer.addHandler('animation', updateZoomLevel);
    mainViewer.addHandler('zoom', updateZoomLevel);

    function updateZoomLevel() {
      if (!homeZoom) return;
      const current = mainViewer.viewport.getZoom();
      const pct = Math.round((current / homeZoom) * 100);
      zoomLevel.textContent = pct + '%';
    }

    // Empêcher le zoom navigateur (Ctrl+molette) sans bloquer le scroll normal
    document.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
      }
    }, { passive: false });

    // Empêcher Ctrl+= et Ctrl+- de zoomer le navigateur
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0')) {
        e.preventDefault();
        if (e.key === '=' || e.key === '+') {
          const current = mainViewer.viewport.getZoom();
          mainViewer.viewport.zoomTo(current * 1.5);
        } else if (e.key === '-') {
          const current = mainViewer.viewport.getZoom();
          mainViewer.viewport.zoomTo(current / 1.5);
        } else if (e.key === '0') {
          mainViewer.viewport.goHome();
        }
      }
    });
  }

  /**
   * Rendre la fenêtre de zoom flottante draggable
   */
  function setupZoomPopup() {
    const popup = document.getElementById('zoom-popup');
    const header = document.getElementById('zoom-popup-header');

    if (typeof interact !== 'undefined') {
      interact(popup).draggable({
        allowFrom: header,
        inertia: true,
        modifiers: [
          interact.modifiers.restrictRect({
            restriction: '#viewer-wrapper',
            endOnly: true,
          })
        ],
        listeners: {
          move(event) {
            const target = event.target;
            const x = (parseFloat(target.getAttribute('data-x')) || 0) + event.dx;
            const y = (parseFloat(target.getAttribute('data-y')) || 0) + event.dy;
            target.style.transform = `translate(${x}px, ${y}px)`;
            target.setAttribute('data-x', x);
            target.setAttribute('data-y', y);
          }
        }
      });
    }

    document.getElementById('zoom-popup-close').addEventListener('click', () => {
      popup.classList.add('hidden');
    });
  }

  /**
   * Naviguer vers un point précis du schéma (coordonnées normalisées 0-1)
   */
  function panTo(xPct, yPct, zoom) {
    if (!mainViewer) return;
    const point = new OpenSeadragon.Point(xPct, yPct);
    mainViewer.viewport.panTo(point, false);
    if (zoom) {
      mainViewer.viewport.zoomTo(zoom, point, false);
    }
  }

  /**
   * Afficher la fenêtre de zoom sur un élément
   */
  function showZoomPopup(element) {
    const popup = document.getElementById('zoom-popup');
    popup.classList.remove('hidden');

    // Centrer le zoom viewer sur l'élément
    const point = new OpenSeadragon.Point(element.x_pct, element.y_pct);
    zoomViewer.viewport.panTo(point, true);
    zoomViewer.viewport.zoomTo(15, point, true);

    // Remplir les métadonnées
    const gare = Data.getAllDessertes().get(element.gare_id) || Data.getGare(element.gare_id) || null;
    document.getElementById('zoom-popup-title').textContent = element.identifiant;
    document.getElementById('meta-gare').textContent = gare ? gare.nom : '—';
    document.getElementById('meta-pk').textContent = element.pk ? 'Km ' + element.pk : '—';
    document.getElementById('meta-ligne').textContent = element.ligne || '—';
    document.getElementById('meta-secteur').textContent = element.secteur || '—';
  }

  /**
   * Naviguer sur une zone (fit bounds)
   */
  function showZone(zoneId, zoneName) {
    const zone = Data.getZone(zoneId);
    const name = zone ? zone.nom : (zoneName || zoneId);

    currentZone = zone || { id: zoneId, nom: name, gares: [] };
    const navLabel = document.getElementById('nav-zone-label');
    if (navLabel) navLabel.textContent = name;
    const sidebarZone = document.getElementById('sidebar-zone');
    if (sidebarZone) sidebarZone.textContent = name;

    // Vérifier si une vue calibrée existe pour ce secteur
    const savedView = getSavedZoneView(zoneId);
    if (savedView) {
      mainViewer.viewport.panTo(new OpenSeadragon.Point(savedView.x, savedView.y), false);
      mainViewer.viewport.zoomTo(savedView.zoom, null, false);
    } else if (zone) {
      // Fallback : centrer sur les gares à zoom 1000%
      const gares = zone.gares.map(id => Data.getGare(id)).filter(Boolean);
      if (gares.length > 0) {
        const cx = gares.reduce((s, g) => s + g.x_pct, 0) / gares.length;
        const cy = gares.reduce((s, g) => s + g.y_pct, 0) / gares.length;
        panTo(cx, cy, 10);
      }
    }

    // Charger les éléments dans le sidebar
    Search.loadSidebarForZone(zoneId);
  }

  /**
   * Convertir coordonnées schéma (0-1) → pixels écran
   */
  function schemaToScreen(xPct, yPct) {
    if (!mainViewer) return { x: 0, y: 0 };
    const viewportPoint = new OpenSeadragon.Point(xPct, yPct);
    const pixelPoint = mainViewer.viewport.viewportToViewerElementCoordinates(viewportPoint);
    return { x: pixelPoint.x, y: pixelPoint.y };
  }

  function getMainViewer() { return mainViewer; }
  function getZoomViewer() { return zoomViewer; }
  function getCurrentZone() { return currentZone; }

  /**
   * Sauvegarder la vue courante pour un secteur
   */
  function saveCurrentViewForZone(zoneId) {
    if (!mainViewer) return;
    const center = mainViewer.viewport.getCenter();
    const zoom = mainViewer.viewport.getZoom();
    const view = { x: center.x, y: center.y, zoom: zoom };

    const saved = Store.getJSON('eic_zone_views', {});
    saved[zoneId] = view;
    Store.set('eic_zone_views', saved);

    return view;
  }

  function getSavedZoneView(zoneId) {
    const saved = Store.getJSON('eic_zone_views', {});
    return saved[zoneId] || null;
  }

  function saveDefaultView() {
    if (!mainViewer) return;
    const center = mainViewer.viewport.getCenter();
    const zoom = mainViewer.viewport.getZoom();
    Store.set('eic_default_view', { x: center.x, y: center.y, zoom: zoom });
  }

  return {
    init,
    panTo,
    showZoomPopup,
    showZone,
    schemaToScreen,
    getMainViewer,
    getZoomViewer,
    getCurrentZone,
    saveCurrentViewForZone,
    saveDefaultView,
  };
})();
