/**
 * Baguette magique — sélection de forme par couleur
 * Détecte les pixels connectés de couleur similaire et crée un contour
 */
const MagicWand = (() => {
  let active = false;
  let tolerance = 32; // Tolérance couleur (0-255)
  let lastSelection = null;

  function init() {
    // Le bouton est dans le sidebar tools
    const viewer = Viewer.getMainViewer();
    if (!viewer) return;

    viewer.addHandler('canvas-click', onCanvasClick);
  }

  function setActive(state) {
    active = state;
    const osd = document.getElementById('osd-viewer');
    if (active) {
      osd.style.cursor = 'crosshair';
      showToleranceSlider();
    } else {
      osd.style.cursor = '';
      hideToleranceSlider();
    }
  }

  function isActive() { return active; }

  function showToleranceSlider() {
    let slider = document.getElementById('wand-tolerance');
    if (slider) return;

    const container = document.getElementById('viewer-container');
    const panel = document.createElement('div');
    panel.id = 'wand-tolerance';
    panel.style.cssText = `
      position:absolute; top:8px; left:50%; transform:translateX(-50%); z-index:30;
      background:rgba(144,96,255,0.9); color:#fff; font-family:'JetBrains Mono',monospace;
      font-size:11px; padding:6px 14px; border-radius:4px; display:flex; align-items:center; gap:10px;
    `;
    panel.innerHTML = `
      <span>Baguette magique</span>
      <label style="display:flex;align-items:center;gap:4px;">
        Tolérance:
        <input type="range" id="wand-tolerance-range" min="5" max="100" value="${tolerance}" style="width:80px;">
        <span id="wand-tolerance-value">${tolerance}</span>
      </label>
    `;
    container.appendChild(panel);

    document.getElementById('wand-tolerance-range').addEventListener('input', (e) => {
      tolerance = parseInt(e.target.value);
      document.getElementById('wand-tolerance-value').textContent = tolerance;
    });
  }

  function hideToleranceSlider() {
    const slider = document.getElementById('wand-tolerance');
    if (slider) slider.remove();
  }

  function onCanvasClick(event) {
    if (!active) return;
    event.preventDefaultAction = true;

    const viewer = Viewer.getMainViewer();
    const osdCanvas = getOsdCanvas();
    if (!osdCanvas) return;

    // Position du clic en pixels du canvas OSD
    const viewerEl = document.getElementById('osd-viewer');
    const rect = viewerEl.getBoundingClientRect();
    const clickX = event.position.x;
    const clickY = event.position.y;

    // Ratio CSS → canvas
    const scaleX = osdCanvas.width / viewerEl.offsetWidth;
    const scaleY = osdCanvas.height / viewerEl.offsetHeight;
    const canvasX = Math.round(clickX * scaleX);
    const canvasY = Math.round(clickY * scaleY);

    // Lire les pixels
    const ctx = osdCanvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, osdCanvas.width, osdCanvas.height);

    // Flood fill pour trouver la forme
    const selection = floodFill(imageData, canvasX, canvasY, tolerance);

    if (selection.pixels.length < 5) {
      console.log('Sélection trop petite');
      return;
    }

    // Trouver le contour
    const contour = findContour(selection.mask, osdCanvas.width, osdCanvas.height, selection.bounds);

    // Convertir en coordonnées viewport OSD
    const viewportContour = contour.map(p => {
      const viewerPoint = new OpenSeadragon.Point(p.x / scaleX, p.y / scaleY);
      const vpPoint = viewer.viewport.pointFromPixel(viewerPoint);
      return { x: vpPoint.x, y: vpPoint.y };
    });

    // Simplifier le contour (réduire le nombre de points)
    const simplified = simplifyContour(viewportContour, 0.0005);

    lastSelection = {
      contour: simplified,
      bounds: {
        x: selection.bounds.minX / scaleX,
        y: selection.bounds.minY / scaleY,
        w: (selection.bounds.maxX - selection.bounds.minX) / scaleX,
        h: (selection.bounds.maxY - selection.bounds.minY) / scaleY,
      },
      canvasBounds: selection.bounds,
      pixelCount: selection.pixels.length,
    };

    // Dessiner la sélection sur le canvas d'annotations
    drawSelection(simplified);

    // Proposer d'enregistrer comme élément
    promptSaveSelection(simplified, viewer.viewport.pointFromPixel(
      new OpenSeadragon.Point(clickX, clickY)
    ));
  }

  /**
   * Flood fill — trouve tous les pixels connectés de couleur similaire
   */
  function floodFill(imageData, startX, startY, tol) {
    const w = imageData.width;
    const h = imageData.height;
    const data = imageData.data;
    const mask = new Uint8Array(w * h);
    const pixels = [];

    // Couleur de départ
    const idx = (startY * w + startX) * 4;
    const startR = data[idx];
    const startG = data[idx + 1];
    const startB = data[idx + 2];

    const stack = [[startX, startY]];
    const bounds = { minX: startX, minY: startY, maxX: startX, maxY: startY };

    // Limiter la zone de recherche pour les performances
    const maxPixels = 50000;

    while (stack.length > 0 && pixels.length < maxPixels) {
      const [x, y] = stack.pop();

      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      if (mask[y * w + x]) continue;

      const i = (y * w + x) * 4;
      const dr = Math.abs(data[i] - startR);
      const dg = Math.abs(data[i + 1] - startG);
      const db = Math.abs(data[i + 2] - startB);

      if (dr + dg + db > tol * 3) continue;

      mask[y * w + x] = 1;
      pixels.push({ x, y });

      bounds.minX = Math.min(bounds.minX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.maxY = Math.max(bounds.maxY, y);

      // 4-connecté
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }

    return { pixels, mask, bounds };
  }

  /**
   * Trouver le contour d'une sélection (marching squares simplifié)
   */
  function findContour(mask, w, h, bounds) {
    const contour = [];
    const pad = 2;
    const x0 = Math.max(0, bounds.minX - pad);
    const y0 = Math.max(0, bounds.minY - pad);
    const x1 = Math.min(w - 1, bounds.maxX + pad);
    const y1 = Math.min(h - 1, bounds.maxY + pad);

    // Scanner le bord de la sélection
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!mask[y * w + x]) continue;

        // Est-ce un pixel de bord ? (un voisin n'est pas dans la sélection)
        const isEdge =
          x === 0 || x === w - 1 || y === 0 || y === h - 1 ||
          !mask[y * w + (x - 1)] ||
          !mask[y * w + (x + 1)] ||
          !mask[(y - 1) * w + x] ||
          !mask[(y + 1) * w + x];

        if (isEdge) {
          contour.push({ x, y });
        }
      }
    }

    // Ordonner les points du contour (tri angulaire depuis le centre)
    if (contour.length > 0) {
      const cx = contour.reduce((s, p) => s + p.x, 0) / contour.length;
      const cy = contour.reduce((s, p) => s + p.y, 0) / contour.length;
      contour.sort((a, b) => {
        return Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx);
      });
    }

    return contour;
  }

  /**
   * Simplifier un contour (Douglas-Peucker)
   */
  function simplifyContour(points, epsilon) {
    if (points.length <= 3) return points;

    let maxDist = 0;
    let maxIdx = 0;

    const first = points[0];
    const last = points[points.length - 1];

    for (let i = 1; i < points.length - 1; i++) {
      const dist = pointLineDistance(points[i], first, last);
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }

    if (maxDist > epsilon) {
      const left = simplifyContour(points.slice(0, maxIdx + 1), epsilon);
      const right = simplifyContour(points.slice(maxIdx), epsilon);
      return left.slice(0, -1).concat(right);
    }

    return [first, last];
  }

  function pointLineDistance(point, lineStart, lineEnd) {
    const dx = lineEnd.x - lineStart.x;
    const dy = lineEnd.y - lineStart.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.sqrt((point.x - lineStart.x) ** 2 + (point.y - lineStart.y) ** 2);

    let t = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));

    const projX = lineStart.x + t * dx;
    const projY = lineStart.y + t * dy;
    return Math.sqrt((point.x - projX) ** 2 + (point.y - projY) ** 2);
  }

  /**
   * Dessiner la sélection sur le canvas d'annotations
   */
  function drawSelection(contour) {
    const canvas = document.getElementById('annotation-canvas');
    if (!canvas || contour.length < 3) return;
    const ctx = canvas.getContext('2d');

    // Convertir viewport → écran
    const screenPoints = contour.map(p => Viewer.schemaToScreen(p.x, p.y));

    ctx.save();
    ctx.strokeStyle = '#9060ff';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
    for (let i = 1; i < screenPoints.length; i++) {
      ctx.lineTo(screenPoints[i].x, screenPoints[i].y);
    }
    ctx.closePath();
    ctx.stroke();

    // Remplissage léger
    ctx.fillStyle = 'rgba(144,96,255,0.15)';
    ctx.fill();
    ctx.restore();
  }

  /**
   * Proposer de sauvegarder la sélection comme élément
   */
  function promptSaveSelection(contour, viewportPoint) {
    // Ouvrir le formulaire de calibration avec la forme
    const popup = document.getElementById('calibrate-popup');
    if (!popup) return;

    // Stocker le contour dans le dataset pour le récupérer à la sauvegarde
    popup.dataset.contour = JSON.stringify(contour);

    document.getElementById('calibrate-coords').textContent =
      `x: ${viewportPoint.x.toFixed(6)}  y: ${viewportPoint.y.toFixed(6)} · ${contour.length} pts`;

    document.getElementById('calibrate-type').value = 'aiguille';
    document.getElementById('calibrate-id').value = '';
    document.getElementById('calibrate-gare').value = '';
    document.getElementById('calibrate-ligne').value = '';
    document.getElementById('calibrate-pk').value = '';
    document.getElementById('calibrate-secteur').value = '';
    popup.dataset.editId = '';

    popup.classList.remove('hidden');
    document.getElementById('calibrate-id').focus();
  }

  function getOsdCanvas() {
    const viewer = Viewer.getMainViewer();
    if (!viewer) return null;
    if (viewer.drawer && typeof viewer.drawer.getCanvas === 'function') return viewer.drawer.getCanvas();
    if (viewer.drawer && viewer.drawer.canvas) return viewer.drawer.canvas;
    return null;
  }

  function getLastSelection() { return lastSelection; }

  return {
    init,
    setActive,
    isActive,
    getLastSelection,
    drawSelection,
  };
})();
