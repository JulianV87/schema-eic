/**
 * Export du schéma de situation
 * L'utilisateur choisit une forme de sélection puis dessine la zone à capturer
 */
const Export = (() => {

  let exportTarget = null;   // 'clipboard' ou 'png'
  let shapeMode = null;      // 'rectangle', 'square', 'free'
  let selectionOverlay = null;
  let selectionCanvas = null;

  // Rectangle / carré
  let dragStart = null;
  let currentRect = null;

  // Forme libre
  let freePoints = [];
  let isDrawingFree = false;

  function init() {
    const pngBtn = document.getElementById('btn-export-png');
    const clearBtn = document.getElementById('btn-clear');

    if (pngBtn) pngBtn.addEventListener('click', () => showShapeMenu('png'));
    if (clearBtn) clearBtn.addEventListener('click', confirmClear);
  }

  function confirmClear() {
    if (Annotations.getAnnotations().length === 0) return;
    if (confirm('Effacer toutes les annotations ?')) {
      Annotations.clear();
    }
  }

  /**
   * Menu de choix de forme
   */
  function showShapeMenu(target) {
    exportTarget = target;

    // Fermer un menu existant
    const existing = document.getElementById('export-shape-menu');
    if (existing) existing.remove();

    const btn = target === 'clipboard'
      ? document.getElementById('btn-export-clipboard')
      : document.getElementById('btn-export-png');

    const btnRect = btn.getBoundingClientRect();

    const menu = document.createElement('div');
    menu.id = 'export-shape-menu';
    menu.style.cssText = `
      position:fixed; left:${btnRect.left}px; top:${btnRect.bottom + 4}px; z-index:300;
      background:#0c1220; border:1px solid #2a4266; border-radius:6px;
      box-shadow:0 8px 24px rgba(0,0,0,0.6); overflow:hidden;
      font-family:'JetBrains Mono',monospace; font-size:11px;
      min-width:180px;
    `;

    const title = document.createElement('div');
    title.style.cssText = 'padding:6px 12px; color:#4a6a9a; font-size:9px; letter-spacing:1px; text-transform:uppercase; border-bottom:1px solid #1e304a;';
    title.textContent = 'Forme de sélection';
    menu.appendChild(title);

    const shapes = [
      { id: 'rectangle', icon: '▭', label: 'Rectangle' },
      { id: 'circle', icon: '○', label: 'Cercle' },
      { id: 'free', icon: '✏', label: 'Forme libre' },
    ];

    shapes.forEach(s => {
      const item = document.createElement('div');
      item.style.cssText = 'padding:8px 12px; cursor:pointer; color:#c8daf5; display:flex; align-items:center; gap:8px; transition:background 0.1s;';
      item.innerHTML = `<span style="width:16px;text-align:center;font-size:14px;">${s.icon}</span> ${s.label}`;
      item.addEventListener('mouseenter', () => { item.style.background = '#111a2e'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'none'; });
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.remove();
        startSelection(s.id);
      });
      menu.appendChild(item);
    });

    document.body.appendChild(menu);

    // Fermer au clic ailleurs
    const closeMenu = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 10);
  }

  /**
   * Démarrer la sélection
   */
  function startSelection(shape) {
    shapeMode = shape;
    dragStart = null;
    currentRect = null;
    freePoints = [];
    isDrawingFree = false;

    const container = document.getElementById('viewer-container');
    if (selectionOverlay) selectionOverlay.remove();

    // Overlay transparent pour capturer les events
    selectionOverlay = document.createElement('div');
    selectionOverlay.id = 'selection-overlay';
    selectionOverlay.style.cssText = `
      position:absolute; top:0; left:0; width:100%; height:100%;
      z-index:100; cursor:crosshair; background:rgba(0,0,0,0.1);
    `;
    container.appendChild(selectionOverlay);

    // Canvas pour dessiner la sélection
    selectionCanvas = document.createElement('canvas');
    selectionCanvas.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:101;';
    selectionCanvas.width = container.offsetWidth;
    selectionCanvas.height = container.offsetHeight;
    selectionOverlay.appendChild(selectionCanvas);

    // Message
    const labels = { rectangle: 'rectangle', square: 'carré', free: 'forme libre' };
    const msg = document.createElement('div');
    msg.style.cssText = `
      position:absolute; top:8px; left:50%; transform:translateX(-50%);
      background:rgba(48,128,255,0.9); color:#fff;
      font-family:'JetBrains Mono',monospace; font-size:11px;
      padding:6px 16px; border-radius:4px; z-index:102; pointer-events:none;
    `;
    msg.textContent = `Dessinez un ${labels[shape]} · Échap pour annuler`;
    selectionOverlay.appendChild(msg);

    // Events
    selectionOverlay.addEventListener('mousedown', onMouseDown);
    selectionOverlay.addEventListener('mousemove', onMouseMove);
    selectionOverlay.addEventListener('mouseup', onMouseUp);

    const cancelHandler = (e) => {
      if (e.key === 'Escape') {
        cancelSelection();
        document.removeEventListener('keydown', cancelHandler);
      }
    };
    document.addEventListener('keydown', cancelHandler);
  }

  function onMouseDown(e) {
    const rect = selectionOverlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (shapeMode === 'free') {
      isDrawingFree = true;
      freePoints = [{ x, y }];
    } else {
      dragStart = { x, y };
    }
  }

  function onMouseMove(e) {
    const rect = selectionOverlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const ctx = selectionCanvas.getContext('2d');
    ctx.clearRect(0, 0, selectionCanvas.width, selectionCanvas.height);

    if (shapeMode === 'free' && isDrawingFree) {
      freePoints.push({ x, y });
      drawFreeSelection(ctx);
    } else if (dragStart) {
      if (shapeMode === 'circle') {
        const dx = x - dragStart.x;
        const dy = y - dragStart.y;
        const radius = Math.sqrt(dx * dx + dy * dy);
        currentRect = {
          x: dragStart.x - radius,
          y: dragStart.y - radius,
          w: radius * 2,
          h: radius * 2,
          cx: dragStart.x,
          cy: dragStart.y,
          radius: radius
        };
        drawCircleSelection(ctx, currentRect);
      } else {
        const sx = Math.min(dragStart.x, x);
        const sy = Math.min(dragStart.y, y);
        currentRect = { x: sx, y: sy, w: Math.abs(x - dragStart.x), h: Math.abs(y - dragStart.y) };
        drawRectSelection(ctx, currentRect);
      }
    }
  }

  function onMouseUp(e) {
    if (shapeMode === 'free') {
      isDrawingFree = false;
      if (freePoints.length < 5) { cancelSelection(); return; }
      captureFromFreeSelection();
    } else if (shapeMode === 'circle') {
      if (!currentRect || currentRect.radius < 10) { cancelSelection(); return; }
      captureFromCircle(currentRect);
    } else {
      if (!currentRect || currentRect.w < 10 || currentRect.h < 10) { cancelSelection(); return; }
      captureFromRect(currentRect);
    }
  }

  function drawRectSelection(ctx, r) {
    ctx.save();
    // Assombrir tout sauf la zone
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(0, 0, selectionCanvas.width, selectionCanvas.height);
    ctx.clearRect(r.x, r.y, r.w, r.h);

    // Bordure
    ctx.strokeStyle = '#00d4a0';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    // Dimensions
    ctx.setLineDash([]);
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = '#00d4a0';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(r.w)} × ${Math.round(r.h)}`, r.x + r.w / 2, r.y + r.h + 16);
    ctx.restore();
  }

  function drawCircleSelection(ctx, r) {
    ctx.save();
    // Assombrir tout
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(0, 0, selectionCanvas.width, selectionCanvas.height);

    // Découper le cercle (transparent)
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(r.cx, r.cy, r.radius, 0, Math.PI * 2);
    ctx.fill();

    // Bordure
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = '#00d4a0';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.arc(r.cx, r.cy, r.radius, 0, Math.PI * 2);
    ctx.stroke();

    // Dimensions
    ctx.setLineDash([]);
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = '#00d4a0';
    ctx.textAlign = 'center';
    ctx.fillText(`r=${Math.round(r.radius)}px`, r.cx, r.cy + r.radius + 16);
    ctx.restore();
  }

  function drawFreeSelection(ctx) {
    if (freePoints.length < 2) return;
    ctx.save();
    ctx.strokeStyle = '#00d4a0';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(freePoints[0].x, freePoints[0].y);
    for (let i = 1; i < freePoints.length; i++) {
      ctx.lineTo(freePoints[i].x, freePoints[i].y);
    }
    // Fermer le path
    ctx.lineTo(freePoints[0].x, freePoints[0].y);
    ctx.stroke();

    // Remplissage léger
    ctx.fillStyle = 'rgba(0,212,160,0.08)';
    ctx.fill();
    ctx.restore();
  }

  /**
   * Capturer une zone rectangulaire
   */
  function captureFromRect(region) {
    const shape = { ...region };
    cancelSelection();

    const canvas = compositeRegion(shape);
    if (!canvas) return;
    finishExport(canvas);
  }

  /**
   * Capturer une forme libre → on prend le bounding box et on masque l'extérieur
   */
  /**
   * Capturer un cercle → bounding box + masque circulaire
   */
  function captureFromCircle(circle) {
    const cx = circle.cx;
    const cy = circle.cy;
    const r = circle.radius;
    const region = { x: cx - r, y: cy - r, w: r * 2, h: r * 2 };
    cancelSelection();

    const canvas = compositeRegion(region);
    if (!canvas) return;

    // Appliquer masque circulaire
    const ctx = canvas.getContext('2d');
    const bannerHeight = 36;

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = canvas.width;
    maskCanvas.height = canvas.height;
    const maskCtx = maskCanvas.getContext('2d');

    // Cercle blanc = zone visible
    maskCtx.fillStyle = '#fff';
    maskCtx.beginPath();
    maskCtx.arc(canvas.width / 2, (canvas.height - bannerHeight) / 2, canvas.width / 2, 0, Math.PI * 2);
    maskCtx.fill();
    // Bandeau toujours visible
    maskCtx.fillRect(0, canvas.height - bannerHeight, canvas.width, bannerHeight);

    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(maskCanvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';

    finishExport(canvas);
  }

  function captureFromFreeSelection() {
    const points = [...freePoints];
    cancelSelection();

    // Bounding box
    const minX = Math.min(...points.map(p => p.x));
    const minY = Math.min(...points.map(p => p.y));
    const maxX = Math.max(...points.map(p => p.x));
    const maxY = Math.max(...points.map(p => p.y));
    const region = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };

    if (region.w < 10 || region.h < 10) return;

    const canvas = compositeRegion(region);
    if (!canvas) return;

    // Appliquer le masque de forme libre
    const ctx = canvas.getContext('2d');
    const bannerHeight = 36;

    // Créer un masque
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = canvas.width;
    maskCanvas.height = canvas.height;
    const maskCtx = maskCanvas.getContext('2d');

    // Ratio entre pixels CSS et pixels canvas
    const container = document.getElementById('viewer-container');
    const osdCanvas = getOsdCanvas();
    const scaleX = osdCanvas ? osdCanvas.width / container.offsetWidth : 1;
    const scaleY = osdCanvas ? osdCanvas.height / container.offsetHeight : 1;

    // Dessiner la forme sur le masque
    maskCtx.fillStyle = '#fff';
    maskCtx.beginPath();
    maskCtx.moveTo((points[0].x - minX) * scaleX, (points[0].y - minY) * scaleY);
    for (let i = 1; i < points.length; i++) {
      maskCtx.lineTo((points[i].x - minX) * scaleX, (points[i].y - minY) * scaleY);
    }
    maskCtx.closePath();
    maskCtx.fill();
    // Le bandeau en bas est toujours visible
    maskCtx.fillRect(0, canvas.height - bannerHeight, canvas.width, bannerHeight);

    // Appliquer le masque avec destination-in
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(maskCanvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';

    finishExport(canvas);
  }

  function finishExport(canvas) {
    if (exportTarget === 'clipboard') {
      exportToClipboard(canvas);
    } else {
      exportToPNG(canvas);
    }
  }

  function cancelSelection() {
    shapeMode = null;
    dragStart = null;
    currentRect = null;
    freePoints = [];
    isDrawingFree = false;
    if (selectionOverlay) {
      selectionOverlay.remove();
      selectionOverlay = null;
    }
    selectionCanvas = null;
  }

  /**
   * Récupérer le canvas OSD
   */
  function getOsdCanvas() {
    const viewer = Viewer.getMainViewer();
    if (!viewer) return null;
    if (viewer.drawer && typeof viewer.drawer.getCanvas === 'function') return viewer.drawer.getCanvas();
    if (viewer.drawer && viewer.drawer.canvas) return viewer.drawer.canvas;
    return null;
  }

  /**
   * Composer l'image pour une région (pixels écran)
   */
  function compositeRegion(region) {
    const osdCanvas = getOsdCanvas();
    if (!osdCanvas) return null;

    const container = document.getElementById('viewer-container');
    const containerW = container.offsetWidth;
    const containerH = container.offsetHeight;

    const scaleX = osdCanvas.width / containerW;
    const scaleY = osdCanvas.height / containerH;

    const sx = Math.round(region.x * scaleX);
    const sy = Math.round(region.y * scaleY);
    const sw = Math.round(region.w * scaleX);
    const sh = Math.round(region.h * scaleY);

    if (sw <= 0 || sh <= 0) return null;

    const bannerHeight = 36;
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh + bannerHeight;
    const ctx = canvas.getContext('2d');

    // Couche 1 : OSD
    ctx.drawImage(osdCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

    // Couche 2 : annotations
    const annotCanvas = document.getElementById('annotation-canvas');
    if (annotCanvas && annotCanvas.width > 0) {
      const aScaleX = annotCanvas.width / containerW;
      const aScaleY = annotCanvas.height / containerH;
      ctx.drawImage(annotCanvas,
        region.x * aScaleX, region.y * aScaleY,
        region.w * aScaleX, region.h * aScaleY,
        0, 0, sw, sh
      );
    }

    // Couche 2b : légende (à sa position réelle dans le viewer)
    const legendPanel = document.getElementById('legend-panel');
    if (legendPanel && !legendPanel.classList.contains('hidden')) {
      const containerRect = container.getBoundingClientRect();
      const legendRect = legendPanel.getBoundingClientRect();
      // Position du panneau légende relative au conteneur, puis relative à la sélection
      const legendX = (legendRect.left - containerRect.left - region.x) * scaleX;
      const legendY = (legendRect.top - containerRect.top - region.y) * scaleY;
      const legendW = legendRect.width * scaleX;
      const legendH = legendRect.height * scaleY;
      // Ne dessiner que si la légende est dans la zone sélectionnée
      if (legendX + legendW > 0 && legendX < sw && legendY + legendH > 0 && legendY < sh) {
        drawLegendOnCanvas(ctx, sw, sh, legendX, legendY, scaleX);
      }
    }

    // Couche 3 : bandeau
    const now = new Date();
    const dateStr = now.toLocaleDateString('fr-FR') + ' ' + now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const zone = Viewer.getCurrentZone();
    const zoneName = zone ? zone.nom : '';

    ctx.fillStyle = 'rgba(6,9,15,0.92)';
    ctx.fillRect(0, sh, sw, bannerHeight);
    ctx.font = '12px "JetBrains Mono", monospace';
    ctx.fillStyle = '#4a6a9a';
    ctx.textAlign = 'center';
    ctx.fillText(`EIC Paris Nord · ${dateStr} · ${zoneName}`, sw / 2, sh + bannerHeight / 2 + 4);
    ctx.textAlign = 'start';

    return canvas;
  }

  function drawLegendOnCanvas(ctx, cw, ch, posX, posY, scale) {
    const all = Annotations.getAnnotations();
    const numbered = all.filter(a => a.number != null);
    if (numbered.length === 0) return;

    const s = scale || 1;
    const pad = 12 * s, lh = 18 * s, hh = 22 * s;
    const bw = 200 * s, bh = hh + numbered.length * lh + pad;
    const x = posX != null ? posX : 10;
    const y = posY != null ? posY : 10;

    ctx.save();
    ctx.fillStyle = 'rgba(12,18,32,0.92)';
    ctx.strokeStyle = '#00d4a0';
    ctx.lineWidth = s;
    ctx.beginPath();
    ctx.rect(x, y, bw, bh);
    ctx.fill();
    ctx.stroke();

    ctx.font = `bold ${Math.round(11 * s)}px "JetBrains Mono", monospace`;
    ctx.fillStyle = '#00d4a0';
    ctx.fillText('LÉGENDE', x + pad, y + 16 * s);

    ctx.font = `${Math.round(10 * s)}px "JetBrains Mono", monospace`;
    numbered.forEach((a, i) => {
      const iy = y + hh + i * lh + 12 * s;
      ctx.fillStyle = a.color;
      ctx.beginPath();
      ctx.arc(x + pad + 6 * s, iy - 3 * s, 7 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(String(a.number), x + pad + 6 * s, iy);
      ctx.fillStyle = a.color;
      ctx.fillText(a.symbol || '●', x + pad + 22 * s, iy);
      ctx.fillStyle = '#c8daf5';
      ctx.textAlign = 'left';
      ctx.fillText(a.legendText || a.trainNumber || a.message || a.label || '', x + pad + 36 * s, iy);
    });
    ctx.restore();
  }

  async function exportToClipboard(canvas) {
    try {
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob null')), 'image/png');
      });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);

      const btn = document.getElementById('btn-export-clipboard');
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = 'Copié !';
        btn.style.borderColor = '#00d4a0';
        setTimeout(() => { btn.textContent = orig; btn.style.borderColor = ''; }, 2000);
      }
    } catch (err) {
      console.error('Erreur clipboard:', err);
      exportToPNG(canvas);
    }
  }

  function exportToPNG(canvas) {
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const zone = Viewer.getCurrentZone();
    const name = zone ? zone.nom.replace(/[^a-zA-Z0-9]/g, '_') : 'schema';
    const link = document.createElement('a');
    link.download = `EIC_${name}_${ts}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  return { init };
})();
