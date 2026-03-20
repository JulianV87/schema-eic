/**
 * Mode Calibration
 * Permet de pointer les éléments sur le schéma et de les identifier
 */
const Calibrate = (() => {
  let active = false;
  let pendingCoords = null;
  let pendingShape = null;  // { type, bounds, contour } — forme dessinée

  // État du dessin de forme
  let shapeMode = 'point';  // 'point', 'rectangle', 'circle', 'free'
  let selOverlay = null;
  let selCanvas = null;
  let dragStart = null;
  let currentRect = null;
  let freePoints = [];
  let isDrawingFree = false;

  // Mode debug : visualisation des zones
  let debugOverlay = false;
  let debugCanvas = null;
  let selectedElementId = null;
  let resizeScale = 1.0;

  const TYPE_COLORS = {
    pn: '#3080ff',
    signal: '#00d4a0',
    aiguille: '#ff4040',
    cv: '#ff9520',
    gare: '#ffdd00',
    pk: '#9060ff',
    poste: '#ff40a0',
    autre: '#4a6a9a',
  };
  const DEFAULT_RADIUS = 0.003; // rayon par défaut pour les éléments sans shape

  function init() {
    const btn = document.getElementById('btn-calibrate');
    if (!btn) return;

    btn.addEventListener('click', () => {
      active = !active;
      btn.classList.toggle('active', active);

      if (active) {
        // Désactiver tout outil d'annotation actif
        if (Annotations.setActiveTool) Annotations.setActiveTool(null);
        if (typeof MagicWand !== 'undefined' && MagicWand.setActive) MagicWand.setActive(false);
        document.getElementById('osd-viewer').style.cursor = 'crosshair';
        showShapePicker();
        showStatusMsg('Mode calibration — sélectionnez un mode puis dessinez sur le schéma');
        enableCalibrationClick();
      } else {
        document.getElementById('osd-viewer').style.cursor = '';
        hideStatusMsg();
        hideShapePicker();
        cancelShapeDrawing();
        disableCalibrationClick();
        // Nettoyer le debug overlay
        if (debugOverlay) {
          debugOverlay = false;
          destroyDebugCanvas();
          hideResizeControls();
          const viewer = Viewer.getMainViewer();
          if (viewer) {
            viewer.removeHandler('animation', redrawDebugOverlay);
            viewer.removeHandler('resize', resizeDebugCanvas);
          }
        }
      }
    });

    // Popup events
    document.getElementById('calibrate-close').addEventListener('click', closePopup);
    document.querySelector('#calibrate-popup .popup-overlay').addEventListener('click', closePopup);
    document.getElementById('calibrate-confirm').addEventListener('click', saveElement);

    // Bouton enregistrer la vue
    document.getElementById('calibrate-save-view').addEventListener('click', () => {
      if (!pendingCoords) return;
      // Utiliser l'id de l'élément en cours d'édition, ou en générer un temporaire
      const popup = document.getElementById('calibrate-popup');
      const editId = popup.dataset.editId;
      const id = editId || ('view-' + pendingCoords.x.toFixed(4) + '-' + pendingCoords.y.toFixed(4));
      Viewer.saveCurrentViewForZone(id);
      const btn = document.getElementById('calibrate-save-view');
      btn.textContent = '✓ Vue sauvegardée';
      btn.style.borderColor = 'var(--accent2)';
      btn.style.color = 'var(--accent2)';
      setTimeout(() => {
        btn.textContent = '📌 Enregistrer la vue';
        btn.style.borderColor = '';
        btn.style.color = '';
      }, 2000);
    });

    // Dropdown gare
    setupGareDropdown();

    // Les prefills ne tournent qu'une fois (flag dans Supabase)
    // Après l'import initial ils ne font plus rien
    prefillPNData();
    prefillSectorsInLines();
  }

  function enableCalibrationClick() {
    const viewer = Viewer.getMainViewer();
    if (!viewer) return;
    viewer.addHandler('canvas-click', onCalibrationClick);
  }

  function disableCalibrationClick() {
    const viewer = Viewer.getMainViewer();
    if (!viewer) return;
    viewer.removeHandler('canvas-click', onCalibrationClick);
  }

  function onCalibrationClick(event) {
    if (!active) return;
    if (shapeMode !== 'point') return; // Les autres modes utilisent l'overlay
    // Ne pas intercepter si un outil d'annotation ou la baguette magique est actif
    if (Annotations.getActiveTool && Annotations.getActiveTool()) return;
    if (typeof MagicWand !== 'undefined' && MagicWand.isActive()) return;

    event.preventDefaultAction = true;

    const viewer = Viewer.getMainViewer();
    const viewportPoint = viewer.viewport.pointFromPixel(event.position);

    pendingCoords = { x: viewportPoint.x, y: viewportPoint.y };
    pendingShape = null;

    const nearby = findNearbyElement(viewportPoint.x, viewportPoint.y);
    openCalibrationPopup(nearby);
  }

  function openCalibrationPopup(nearby) {
    const popup = document.getElementById('calibrate-popup');
    popup.dataset.contour = '';

    // Afficher les coordonnées + info sur la forme
    let coordsText = `x: ${pendingCoords.x.toFixed(6)}  y: ${pendingCoords.y.toFixed(6)}`;
    if (pendingShape) {
      const labels = { rectangle: '▭', circle: '○', free: '✏' };
      coordsText += ` · ${labels[pendingShape.type] || ''} forme capturée`;
    }
    document.getElementById('calibrate-coords').textContent = coordsText;

    if (nearby) {
      document.getElementById('calibrate-type').value = nearby.type || 'autre';
      document.getElementById('calibrate-id').value = nearby.identifiant || '';
      document.getElementById('calibrate-gare').value = getGareName(nearby.gare_id) || '';
      document.getElementById('calibrate-ligne').value = nearby.ligne || '';
      document.getElementById('calibrate-pk').value = nearby.pk || '';
      document.getElementById('calibrate-secteur').value = nearby.secteur || '';
      popup.dataset.editId = nearby.id;
    } else {
      document.getElementById('calibrate-type').value = 'aiguille';
      document.getElementById('calibrate-id').value = '';
      document.getElementById('calibrate-gare').value = '';
      document.getElementById('calibrate-ligne').value = '';
      document.getElementById('calibrate-pk').value = '';
      document.getElementById('calibrate-secteur').value = '';
      popup.dataset.editId = '';
    }

    populateLigneList();
    popup.classList.remove('hidden');
    document.getElementById('calibrate-id').focus();
  }

  /**
   * Chercher un élément dont la shape sauvegardée chevauche significativement les bounds données
   * Utilisé en mode forme pour éviter d'écraser un élément voisin
   */
  function findOverlappingElement(newBounds) {
    if (!newBounds) return null;
    const allElements = Data.searchElementFuzzy('');
    let bestMatch = null;
    let bestOverlap = 0;

    for (const el of allElements) {
      if (!el.shape || !el.shape.bounds) continue;
      const b = el.shape.bounds;

      // Calculer l'intersection des deux rectangles
      const overlapX = Math.max(0, Math.min(b.x + b.w, newBounds.x + newBounds.w) - Math.max(b.x, newBounds.x));
      const overlapY = Math.max(0, Math.min(b.y + b.h, newBounds.y + newBounds.h) - Math.max(b.y, newBounds.y));
      const overlapArea = overlapX * overlapY;

      if (overlapArea <= 0) continue;

      // L'overlap doit couvrir au moins 30% de l'un des deux rectangles
      const existingArea = b.w * b.h;
      const newArea = newBounds.w * newBounds.h;
      const overlapRatio = Math.max(overlapArea / existingArea, overlapArea / newArea);

      if (overlapRatio > 0.3 && overlapArea > bestOverlap) {
        bestOverlap = overlapArea;
        bestMatch = el;
      }
    }

    return bestMatch;
  }

  function findNearbyElement(x, y) {
    const threshold = 0.005; // ~0.5% du schéma
    let closest = null;
    let minDist = threshold;

    const allElements = Data.searchElementFuzzy(''); // Tous les éléments

    // 1. D'abord chercher si le point est à l'intérieur d'une forme sauvegardée
    for (const el of allElements) {
      if (el.shape && el.shape.bounds) {
        const b = el.shape.bounds;
        if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
          return el; // Le clic est dans la zone calibrée
        }
      }
    }

    // 2. Sinon chercher par proximité au point central
    allElements.forEach(el => {
      const dx = el.x_pct - x;
      const dy = el.y_pct - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < minDist) {
        minDist = dist;
        closest = el;
      }
    });

    // 3. Fallback: chercher dans les éléments par zone
    if (!closest) {
      Data.getZones().forEach(z => {
        Data.getElementsForZone(z.id).forEach(el => {
          const dx = el.x_pct - x;
          const dy = el.y_pct - y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < minDist) {
            minDist = dist;
            closest = el;
          }
        });
      });
    }

    return closest;
  }

  function getGareName(gareId) {
    if (!gareId) return '';
    const gare = Data.getGare(gareId) || Data.getAllDessertes().get(gareId) || null;
    return gare ? gare.nom : '';
  }

  function saveElement() {
    const popup = document.getElementById('calibrate-popup');
    const identifiant = document.getElementById('calibrate-id').value.trim();
    if (!identifiant) {
      document.getElementById('calibrate-id').focus();
      return;
    }

    const type = document.getElementById('calibrate-type').value;
    const gareName = document.getElementById('calibrate-gare').value.trim();
    const ligne = document.getElementById('calibrate-ligne').value.trim();
    const pk = document.getElementById('calibrate-pk').value.trim();
    const secteur = document.getElementById('calibrate-secteur').value.trim();

    // Trouver la desserte par nom (toutes les dessertes, pas juste les gares PDF)
    let gareId = null;
    if (gareName) {
      const q = gareName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[-'']/g, ' ').trim();
      Data.getAllDessertes().forEach((d, id) => {
        if (!gareId) {
          const n = (d.nom || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[-'']/g, ' ').trim();
          if (n === q) gareId = id;
        }
      });
      if (!gareId) {
        Data.getAllDessertes().forEach((d, id) => {
          if (!gareId) {
            const n = (d.nom || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[-'']/g, ' ').trim();
            if (n.includes(q)) gareId = id;
          }
        });
      }
      // Fallback gares PDF
      if (!gareId) {
        const matches = Data.searchGare(gareName);
        if (matches.length > 0) gareId = matches[0].id;
      }
    }

    const editId = popup.dataset.editId;
    const id = editId || Data.generateId();

    const element = {
      id: id,
      type: type,
      identifiant: identifiant,
      gare_id: gareId,
      ligne: ligne,
      pk: pk,
      secteur: secteur,
      x_pct: pendingCoords.x,
      y_pct: pendingCoords.y,
      source: 'manual',
      validated: true,
    };

    // Si c'est une gare
    if (type === 'gare') {
      element._isGare = true;
      element.nom = identifiant;
      element.nom_court = '';
      element.zone_id = null;
    }

    // Sauvegarder la forme dessinée (rectangle, cercle, libre) ou le contour baguette magique
    if (pendingShape) {
      element.shape = pendingShape;
    } else {
      const contourData = popup.dataset.contour;
      if (contourData) {
        try { element.shape = JSON.parse(contourData); } catch {}
        popup.dataset.contour = '';
      }
    }

    Data.saveManualElement(element);

    // Sauvegarder la vue pour cet élément (si elle n'existe pas encore)
    if (!Data.hasSavedView(id)) {
      Viewer.saveCurrentViewForZone(id);
    }

    closePopup();

    // Feedback visuel
    showStatusMsg(`${identifiant} enregistré à (${pendingCoords.x.toFixed(4)}, ${pendingCoords.y.toFixed(4)})`);
    setTimeout(() => {
      if (active) showStatusMsg('Mode calibration — cliquez sur un élément du schéma');
    }, 2000);

    // Rafraîchir le sidebar si une zone est active
    const zone = Viewer.getCurrentZone();
    if (zone) {
      Search.loadSidebarForZone(zone.id);
    }

    // Rafraîchir les paramètres s'ils sont ouverts
    try {
      const settingsPopup = document.getElementById('settings-popup');
      if (settingsPopup && !settingsPopup.classList.contains('hidden')) {
        console.log('Rafraîchissement paramètres...');
        Settings.renderTab(null);
      } else {
        console.log('Paramètres fermés, pas de rafraîchissement');
      }
    } catch (e) {
      console.error('Erreur rafraîchissement paramètres:', e);
    }
  }

  function closePopup() {
    document.getElementById('calibrate-popup').classList.add('hidden');
    pendingShape = null;
    // Relancer le dessin si toujours en mode forme
    if (active && shapeMode !== 'point') {
      startShapeDrawing(shapeMode);
    }
  }

  // === SÉLECTEUR DE FORME ===

  function showShapePicker() {
    let picker = document.getElementById('calibrate-shape-picker');
    if (picker) return;

    const container = document.getElementById('viewer-container');
    picker = document.createElement('div');
    picker.id = 'calibrate-shape-picker';
    picker.style.cssText = `
      position:absolute; top:8px; right:12px; z-index:30;
      background:rgba(12,18,32,0.95); border:1px solid #2a4266; border-radius:6px;
      font-family:'JetBrains Mono',monospace; font-size:11px;
      display:flex; gap:2px; padding:3px;
    `;

    const modes = [
      { id: 'point', icon: '·', label: 'Point' },
      { id: 'rectangle', icon: '▭', label: 'Rectangle' },
      { id: 'circle', icon: '○', label: 'Cercle' },
      { id: 'free', icon: '✏', label: 'Libre' },
      { id: '_sep' },
      { id: 'zones', icon: '◫', label: 'Zones', toggle: true },
    ];

    modes.forEach(m => {
      if (m.id === '_sep') {
        const sep = document.createElement('div');
        sep.style.cssText = 'width:1px;background:#2a4266;margin:2px 4px;';
        picker.appendChild(sep);
        return;
      }
      if (m.toggle) {
        const btn = document.createElement('button');
        btn.dataset.mode = m.id;
        btn.title = 'Afficher/masquer les zones calibrées';
        btn.style.cssText = `
          padding:5px 10px; border:1px solid transparent; border-radius:4px;
          background:${debugOverlay ? '#1a2a10' : 'none'}; color:${debugOverlay ? '#00d4a0' : '#4a6a9a'};
          cursor:pointer; font-size:13px; transition:all 0.15s;
        `;
        btn.textContent = m.icon + ' ' + m.label;
        btn.addEventListener('click', () => toggleDebugOverlay());
        picker.appendChild(btn);
        return;
      }
      const btn = document.createElement('button');
      btn.className = 'calibrate-shape-btn' + (m.id === shapeMode ? ' active' : '');
      btn.dataset.mode = m.id;
      btn.title = m.label;
      btn.style.cssText = `
        padding:5px 10px; border:1px solid transparent; border-radius:4px;
        background:${m.id === shapeMode ? '#1e304a' : 'none'}; color:${m.id === shapeMode ? '#ff9520' : '#4a6a9a'};
        cursor:pointer; font-size:13px; transition:all 0.15s;
      `;
      btn.textContent = m.icon + ' ' + m.label;
      btn.addEventListener('click', () => {
        setShapeMode(m.id);
      });
      btn.addEventListener('mouseenter', () => {
        if (m.id !== shapeMode) btn.style.color = '#c8daf5';
      });
      btn.addEventListener('mouseleave', () => {
        if (m.id !== shapeMode) btn.style.color = '#4a6a9a';
      });
      picker.appendChild(btn);
    });

    container.appendChild(picker);
  }

  function hideShapePicker() {
    const picker = document.getElementById('calibrate-shape-picker');
    if (picker) picker.remove();
  }

  function setShapeMode(mode) {
    shapeMode = mode;
    cancelShapeDrawing();

    // Mettre à jour les boutons
    const picker = document.getElementById('calibrate-shape-picker');
    if (picker) {
      picker.querySelectorAll('button').forEach(btn => {
        const isActive = btn.dataset.mode === mode;
        btn.style.background = isActive ? '#1e304a' : 'none';
        btn.style.color = isActive ? '#ff9520' : '#4a6a9a';
      });
    }

    const viewer = Viewer.getMainViewer();
    if (!viewer) return;

    if (mode === 'point') {
      showStatusMsg('Mode calibration — cliquez sur un élément');
      enableCalibrationClick();
    } else {
      const labels = { rectangle: 'un rectangle', circle: 'un cercle', free: 'une forme libre' };
      showStatusMsg(`Dessinez ${labels[mode]} autour de l'élément · Échap pour annuler`);
      disableCalibrationClick();
      startShapeDrawing(mode);
    }
  }

  // === DESSIN DE FORME SUR LE SCHÉMA ===

  function startShapeDrawing(shape) {
    cancelShapeDrawing();

    const container = document.getElementById('viewer-container');
    dragStart = null;
    currentRect = null;
    freePoints = [];
    isDrawingFree = false;

    // Overlay pour capturer les events souris
    selOverlay = document.createElement('div');
    selOverlay.id = 'calibrate-sel-overlay';
    selOverlay.style.cssText = `
      position:absolute; top:0; left:0; width:100%; height:100%;
      z-index:20; cursor:crosshair;
    `;
    container.appendChild(selOverlay);

    // Canvas pour dessiner la sélection
    selCanvas = document.createElement('canvas');
    selCanvas.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:21;';
    selCanvas.width = container.offsetWidth;
    selCanvas.height = container.offsetHeight;
    selOverlay.appendChild(selCanvas);

    selOverlay.addEventListener('mousedown', onShapeMouseDown);
    selOverlay.addEventListener('mousemove', onShapeMouseMove);
    selOverlay.addEventListener('mouseup', onShapeMouseUp);

    const cancelHandler = (e) => {
      if (e.key === 'Escape') {
        cancelShapeDrawing();
        if (active) setShapeMode('point');
        document.removeEventListener('keydown', cancelHandler);
      }
    };
    document.addEventListener('keydown', cancelHandler);
  }

  function cancelShapeDrawing() {
    dragStart = null;
    currentRect = null;
    freePoints = [];
    isDrawingFree = false;
    if (selOverlay) { selOverlay.remove(); selOverlay = null; }
    selCanvas = null;
  }

  function onShapeMouseDown(e) {
    const rect = selOverlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (shapeMode === 'free') {
      isDrawingFree = true;
      freePoints = [{ x, y }];
    } else {
      dragStart = { x, y };
    }
  }

  function onShapeMouseMove(e) {
    if (!selCanvas) return;
    const rect = selOverlay.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const ctx = selCanvas.getContext('2d');
    ctx.clearRect(0, 0, selCanvas.width, selCanvas.height);

    if (shapeMode === 'free' && isDrawingFree) {
      freePoints.push({ x, y });
      drawFreePreview(ctx);
    } else if (dragStart) {
      if (shapeMode === 'circle') {
        const dx = x - dragStart.x;
        const dy = y - dragStart.y;
        const radius = Math.sqrt(dx * dx + dy * dy);
        currentRect = { cx: dragStart.x, cy: dragStart.y, radius };
        drawCirclePreview(ctx, currentRect);
      } else {
        const sx = Math.min(dragStart.x, x);
        const sy = Math.min(dragStart.y, y);
        currentRect = { x: sx, y: sy, w: Math.abs(x - dragStart.x), h: Math.abs(y - dragStart.y) };
        drawRectPreview(ctx, currentRect);
      }
    }
  }

  function onShapeMouseUp(e) {
    const viewer = Viewer.getMainViewer();
    if (!viewer) return;

    let shapeBounds = null;  // en pixels CSS
    let shapeContour = null; // en coordonnées viewport OSD

    if (shapeMode === 'free') {
      isDrawingFree = false;
      if (freePoints.length < 5) { cancelShapeDrawing(); startShapeDrawing('free'); return; }

      const minX = Math.min(...freePoints.map(p => p.x));
      const minY = Math.min(...freePoints.map(p => p.y));
      const maxX = Math.max(...freePoints.map(p => p.x));
      const maxY = Math.max(...freePoints.map(p => p.y));
      shapeBounds = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };

      // Convertir en coordonnées viewport
      shapeContour = freePoints.map(p => {
        const vp = viewer.viewport.pointFromPixel(new OpenSeadragon.Point(p.x, p.y));
        return { x: vp.x, y: vp.y };
      });
    } else if (shapeMode === 'circle') {
      if (!currentRect || currentRect.radius < 5) { cancelShapeDrawing(); startShapeDrawing('circle'); return; }
      const r = currentRect.radius;
      shapeBounds = { x: currentRect.cx - r, y: currentRect.cy - r, w: r * 2, h: r * 2 };
    } else {
      if (!currentRect || currentRect.w < 5 || currentRect.h < 5) { cancelShapeDrawing(); startShapeDrawing('rectangle'); return; }
      shapeBounds = { ...currentRect };
    }

    // Calculer le centre en coordonnées viewport OSD
    const centerX = shapeBounds.x + shapeBounds.w / 2;
    const centerY = shapeBounds.y + shapeBounds.h / 2;
    const vpCenter = viewer.viewport.pointFromPixel(new OpenSeadragon.Point(centerX, centerY));

    // Convertir les bounds en viewport
    const vpTopLeft = viewer.viewport.pointFromPixel(new OpenSeadragon.Point(shapeBounds.x, shapeBounds.y));
    const vpBottomRight = viewer.viewport.pointFromPixel(new OpenSeadragon.Point(shapeBounds.x + shapeBounds.w, shapeBounds.y + shapeBounds.h));

    pendingCoords = { x: vpCenter.x, y: vpCenter.y };
    pendingShape = {
      type: shapeMode,
      bounds: { x: vpTopLeft.x, y: vpTopLeft.y, w: vpBottomRight.x - vpTopLeft.x, h: vpBottomRight.y - vpTopLeft.y },
      contour: shapeContour || null,
    };

    cancelShapeDrawing();

    // En mode forme, chercher uniquement un élément dont la shape chevauche la nouvelle
    // (ne PAS utiliser la proximité au centre, sinon on risque d'écraser un voisin)
    const nearby = findOverlappingElement(pendingShape.bounds);

    // Ouvrir le popup
    openCalibrationPopup(nearby);

    // Relancer le dessin pour le prochain élément
    // (sera fait après fermeture du popup ou automatiquement)
  }

  function drawRectPreview(ctx, r) {
    ctx.save();
    ctx.strokeStyle = '#ff9520';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = 'rgba(255,149,32,0.1)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.setLineDash([]);
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = '#ff9520';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(r.w)} × ${Math.round(r.h)}`, r.x + r.w / 2, r.y + r.h + 14);
    ctx.restore();
  }

  function drawCirclePreview(ctx, c) {
    ctx.save();
    ctx.strokeStyle = '#ff9520';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.arc(c.cx, c.cy, c.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,149,32,0.1)';
    ctx.fill();
    ctx.setLineDash([]);
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.fillStyle = '#ff9520';
    ctx.textAlign = 'center';
    ctx.fillText(`r=${Math.round(c.radius)}px`, c.cx, c.cy + c.radius + 14);
    ctx.restore();
  }

  function drawFreePreview(ctx) {
    if (freePoints.length < 2) return;
    ctx.save();
    ctx.strokeStyle = '#ff9520';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(freePoints[0].x, freePoints[0].y);
    for (let i = 1; i < freePoints.length; i++) {
      ctx.lineTo(freePoints[i].x, freePoints[i].y);
    }
    ctx.lineTo(freePoints[0].x, freePoints[0].y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,149,32,0.08)';
    ctx.fill();
    ctx.restore();
  }

  // === VISUALISATION DEBUG DES ZONES ===

  function toggleDebugOverlay() {
    debugOverlay = !debugOverlay;
    if (debugOverlay) {
      createDebugCanvas();
      redrawDebugOverlay();
      // Re-dessiner à chaque mouvement du viewport
      const viewer = Viewer.getMainViewer();
      if (viewer) {
        viewer.addHandler('animation', redrawDebugOverlay);
        viewer.addHandler('resize', resizeDebugCanvas);
      }
      showResizeControls();
    } else {
      destroyDebugCanvas();
      hideResizeControls();
      const viewer = Viewer.getMainViewer();
      if (viewer) {
        viewer.removeHandler('animation', redrawDebugOverlay);
        viewer.removeHandler('resize', resizeDebugCanvas);
      }
      selectedElementId = null;
    }
    // Mettre à jour le bouton
    hideShapePicker();
    showShapePicker();
  }

  function createDebugCanvas() {
    if (debugCanvas) return;
    const container = document.getElementById('viewer-container');
    debugCanvas = document.createElement('canvas');
    debugCanvas.id = 'calibrate-debug-canvas';
    debugCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:11;';
    debugCanvas.width = container.offsetWidth;
    debugCanvas.height = container.offsetHeight;
    container.appendChild(debugCanvas);

    // Activer les clics sur le debug canvas pour sélectionner
    debugCanvas.style.pointerEvents = 'auto';
    debugCanvas.style.cursor = 'pointer';
    debugCanvas.addEventListener('click', onDebugClick);
  }

  function destroyDebugCanvas() {
    if (debugCanvas) {
      debugCanvas.removeEventListener('click', onDebugClick);
      debugCanvas.remove();
      debugCanvas = null;
    }
  }

  function resizeDebugCanvas() {
    if (!debugCanvas) return;
    const container = document.getElementById('viewer-container');
    debugCanvas.width = container.offsetWidth;
    debugCanvas.height = container.offsetHeight;
    redrawDebugOverlay();
  }

  function redrawDebugOverlay() {
    if (!debugCanvas) return;
    const ctx = debugCanvas.getContext('2d');
    ctx.clearRect(0, 0, debugCanvas.width, debugCanvas.height);

    const allElements = Data.searchElementFuzzy('');

    allElements.forEach(el => {
      const color = TYPE_COLORS[el.type] || TYPE_COLORS.autre;
      const isSelected = el.id === selectedElementId;
      const alpha = isSelected ? 0.5 : 0.2;
      const strokeAlpha = isSelected ? 1 : 0.6;

      if (el.shape && el.shape.bounds) {
        // Élément avec shape → dessiner les bounds
        const b = el.shape.bounds;
        const tl = Viewer.schemaToScreen(b.x, b.y);
        const br = Viewer.schemaToScreen(b.x + b.w, b.y + b.h);
        const w = br.x - tl.x;
        const h = br.y - tl.y;

        if (w < 1 && h < 1) return; // Hors écran ou trop petit

        ctx.save();
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha;
        ctx.fillRect(tl.x, tl.y, w, h);
        ctx.globalAlpha = strokeAlpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = isSelected ? 2 : 1;
        if (!isSelected) ctx.setLineDash([3, 3]);
        ctx.strokeRect(tl.x, tl.y, w, h);
        ctx.setLineDash([]);

        // Label
        ctx.globalAlpha = 0.9;
        ctx.font = '9px "JetBrains Mono", monospace';
        ctx.fillStyle = '#fff';
        ctx.fillText(el.identifiant || el.id, tl.x + 2, tl.y - 3);
        ctx.restore();
      } else {
        // Élément sans shape → dessiner un cercle à sa position
        const pos = Viewer.schemaToScreen(el.x_pct, el.y_pct);
        const r = Math.max(4, 8 * (isSelected ? 1.5 : 1));

        ctx.save();
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha + 0.1;
        ctx.fill();
        ctx.globalAlpha = strokeAlpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.stroke();

        // Label
        ctx.globalAlpha = 0.8;
        ctx.font = '8px "JetBrains Mono", monospace';
        ctx.fillStyle = '#fff';
        ctx.fillText(el.identifiant || '', pos.x + r + 2, pos.y + 3);
        ctx.restore();
      }
    });

    // Légende des types en bas à gauche
    drawDebugLegend(ctx);
  }

  function drawDebugLegend(ctx) {
    const x = 10, y = debugCanvas.height - 10;
    const types = Object.entries(TYPE_COLORS);
    const lh = 14;
    const totalH = types.length * lh + 8;

    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = 'rgba(12,18,32,0.9)';
    ctx.fillRect(x, y - totalH, 100, totalH);
    ctx.font = '9px "JetBrains Mono", monospace';

    types.forEach(([type, color], i) => {
      const ly = y - totalH + 12 + i * lh;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(x + 8, ly - 3, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#c8daf5';
      ctx.fillText(type, x + 18, ly);
    });
    ctx.restore();
  }

  function onDebugClick(e) {
    const rect = debugCanvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    const viewer = Viewer.getMainViewer();
    if (!viewer) return;
    const vp = viewer.viewport.pointFromPixel(new OpenSeadragon.Point(cx, cy));

    // Chercher l'élément cliqué
    const clicked = findNearbyElement(vp.x, vp.y);
    if (clicked) {
      selectedElementId = clicked.id;
      resizeScale = 1.0;
      updateResizeControls();
      redrawDebugOverlay();
    } else {
      selectedElementId = null;
      redrawDebugOverlay();
    }
  }

  function showResizeControls() {
    let panel = document.getElementById('debug-resize-panel');
    if (panel) return;

    const container = document.getElementById('viewer-container');
    panel = document.createElement('div');
    panel.id = 'debug-resize-panel';
    panel.style.cssText = `
      position:absolute; bottom:8px; right:12px; z-index:30;
      background:rgba(12,18,32,0.95); border:1px solid #2a4266; border-radius:6px;
      font-family:'JetBrains Mono',monospace; font-size:10px; color:#c8daf5;
      padding:8px 12px; display:flex; flex-direction:column; gap:6px; min-width:200px;
    `;

    panel.innerHTML = `
      <div style="font-size:8px;letter-spacing:1px;text-transform:uppercase;color:#4a6a9a;">Élément sélectionné</div>
      <div id="debug-selected-name" style="color:#ff9520;">Aucun</div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span>Zone:</span>
        <button id="debug-shrink" style="padding:2px 8px;background:#1e304a;border:1px solid #2a4266;border-radius:3px;color:#ff4040;cursor:pointer;font-size:12px;">−</button>
        <span id="debug-scale-label">100%</span>
        <button id="debug-grow" style="padding:2px 8px;background:#1e304a;border:1px solid #2a4266;border-radius:3px;color:#00d4a0;cursor:pointer;font-size:12px;">+</button>
      </div>
      <button id="debug-apply" style="padding:4px;background:#00d4a0;border:none;border-radius:3px;color:#0c1220;font-family:var(--mono);font-size:10px;font-weight:600;cursor:pointer;">Appliquer</button>
    `;
    container.appendChild(panel);

    document.getElementById('debug-shrink').addEventListener('click', () => {
      resizeScale = Math.max(0.2, resizeScale - 0.1);
      updateResizeControls();
      previewResize();
    });
    document.getElementById('debug-grow').addEventListener('click', () => {
      resizeScale = Math.min(3.0, resizeScale + 0.1);
      updateResizeControls();
      previewResize();
    });
    document.getElementById('debug-apply').addEventListener('click', applyResize);
  }

  function hideResizeControls() {
    const panel = document.getElementById('debug-resize-panel');
    if (panel) panel.remove();
  }

  function updateResizeControls() {
    const nameEl = document.getElementById('debug-selected-name');
    const scaleEl = document.getElementById('debug-scale-label');
    if (!nameEl || !scaleEl) return;

    if (selectedElementId) {
      const el = Data.searchElementFuzzy('').find(e => e.id === selectedElementId);
      nameEl.textContent = el ? (el.identifiant + ' (' + el.type + ')') : selectedElementId;
      nameEl.style.color = el ? (TYPE_COLORS[el.type] || '#ff9520') : '#ff9520';
    } else {
      nameEl.textContent = 'Aucun';
      nameEl.style.color = '#ff9520';
    }
    scaleEl.textContent = Math.round(resizeScale * 100) + '%';
  }

  function previewResize() {
    if (!selectedElementId) return;
    redrawDebugOverlay();

    // Dessiner un aperçu de la nouvelle taille
    const el = Data.searchElementFuzzy('').find(e => e.id === selectedElementId);
    if (!el || !debugCanvas) return;

    const ctx = debugCanvas.getContext('2d');
    ctx.save();
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = '#ffdd00';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);

    if (el.shape && el.shape.bounds) {
      const b = el.shape.bounds;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const nw = b.w * resizeScale;
      const nh = b.h * resizeScale;
      const tl = Viewer.schemaToScreen(cx - nw / 2, cy - nh / 2);
      const br = Viewer.schemaToScreen(cx + nw / 2, cy + nh / 2);
      ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    } else {
      const pos = Viewer.schemaToScreen(el.x_pct, el.y_pct);
      const r = DEFAULT_RADIUS * resizeScale;
      const tl = Viewer.schemaToScreen(el.x_pct - r, el.y_pct - r);
      const br = Viewer.schemaToScreen(el.x_pct + r, el.y_pct + r);
      const w = br.x - tl.x;
      const h = br.y - tl.y;
      ctx.strokeRect(tl.x, tl.y, w, h);
    }
    ctx.restore();
  }

  function applyResize() {
    if (!selectedElementId || resizeScale === 1.0) return;

    const el = Data.searchElementFuzzy('').find(e => e.id === selectedElementId);
    if (!el) return;

    if (el.shape && el.shape.bounds) {
      const b = el.shape.bounds;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const nw = b.w * resizeScale;
      const nh = b.h * resizeScale;
      el.shape.bounds = { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh };
    } else {
      // Créer une shape à partir du point
      const r = DEFAULT_RADIUS * resizeScale;
      el.shape = {
        type: 'rectangle',
        bounds: { x: el.x_pct - r, y: el.y_pct - r, w: r * 2, h: r * 2 },
        contour: null,
      };
    }

    Data.saveManualElement(el);
    resizeScale = 1.0;
    updateResizeControls();
    redrawDebugOverlay();
    showStatusMsg(`Zone de ${el.identifiant} redimensionnée`);
    setTimeout(() => { if (active) showStatusMsg('Mode calibration'); }, 1500);
  }

  function showStatusMsg(msg) {
    let el = document.getElementById('calibrate-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'calibrate-status';
      el.style.cssText = `position:absolute; top:8px; left:50%; transform:translateX(-50%); z-index:30;
        background:rgba(255,149,32,0.9); color:#fff; font-family:'JetBrains Mono',monospace;
        font-size:11px; padding:4px 14px; border-radius:4px; pointer-events:none;`;
      document.getElementById('viewer-container').appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
  }

  function hideStatusMsg() {
    const el = document.getElementById('calibrate-status');
    if (el) el.style.display = 'none';
  }

  // === DROPDOWN GARE GROUPÉ PAR TABLE ===

  function setupGareDropdown() {
    const input = document.getElementById('calibrate-gare');
    const dropdown = document.getElementById('calibrate-gare-dropdown');
    if (!input || !dropdown) return;

    input.addEventListener('focus', () => {
      populateGareDropdown(input.value);
      dropdown.classList.remove('hidden');
    });

    input.addEventListener('input', () => {
      populateGareDropdown(input.value);
      dropdown.classList.remove('hidden');
    });

    input.addEventListener('blur', () => {
      // Délai pour laisser le clic se propager
      setTimeout(() => dropdown.classList.add('hidden'), 150);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        dropdown.classList.add('hidden');
      }
    });
  }

  function populateGareDropdown(filter) {
    const dropdown = document.getElementById('calibrate-gare-dropdown');
    if (!dropdown) return;
    dropdown.innerHTML = '';

    const input = document.getElementById('calibrate-gare');
    const q = (filter || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[-'']/g, ' ').replace(/\bsaint\b/g, 'st').replace(/\bsainte\b/g, 'ste');

    // Liste unifiée via Data.getAllDessertes()
    const allDessertes = Data.getAllDessertes();

    // Construire index desserte → zoneIds dans le layout
    let layout = null;
    try { layout = Store.getJSON('eic_zone_layout', {}); } catch {}

    const desserteByLine = new Map(); // zoneId → [table names]
    const assignedIds = new Set();
    if (layout && layout.tables) {
      layout.tables.forEach(table => {
        (table.lines || []).forEach(line => {
          (line.zoneIds || []).forEach(zoneId => {
            assignedIds.add(zoneId);
            if (!desserteByLine.has(zoneId)) desserteByLine.set(zoneId, new Set());
            desserteByLine.get(zoneId).add(table.nom);
          });
        });
      });
    }

    function norm(s) {
      return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[-'']/g, ' ').replace(/\bsaint\b/g, 'st').replace(/\bsainte\b/g, 'ste');
    }

    // Grouper par table
    if (layout && layout.tables) {
      layout.tables.forEach(table => {
        const tableDessertes = [];
        const seen = new Set();
        (table.lines || []).forEach(line => {
          (line.zoneIds || []).forEach(zoneId => {
            if (seen.has(zoneId)) return;
            seen.add(zoneId);
            const d = allDessertes.get(zoneId);
            if (!d) return;
            if (q && !norm(d.nom).includes(q)) return;
            tableDessertes.push(d);
          });
        });

        if (tableDessertes.length === 0) return;

        const groupEl = document.createElement('div');
        groupEl.className = 'calibrate-dropdown-group';
        groupEl.textContent = table.nom;
        dropdown.appendChild(groupEl);

        tableDessertes.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
        tableDessertes.forEach(d => {
          const item = document.createElement('div');
          item.className = 'calibrate-dropdown-item';
          item.textContent = d.nom;
          item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            input.value = d.nom;
            dropdown.classList.add('hidden');
          });
          dropdown.appendChild(item);
        });
      });
    }

    // Non classées
    const others = [];
    allDessertes.forEach((d, id) => {
      if (assignedIds.has(id)) return;
      if (q && !norm(d.nom).includes(q)) return;
      others.push(d);
    });

    if (others.length > 0) {
      const groupEl = document.createElement('div');
      groupEl.className = 'calibrate-dropdown-group';
      groupEl.textContent = 'Autres';
      dropdown.appendChild(groupEl);

      others.sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
      others.forEach(d => {
        const item = document.createElement('div');
        item.className = 'calibrate-dropdown-item';
        item.textContent = d.nom;
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          input.value = d.nom;
          dropdown.classList.add('hidden');
        });
        dropdown.appendChild(item);
      });
    }
  }

  // === PRÉ-REMPLISSAGE DES PN ===

  function prefillPNData() {
    // Ne faire qu'une seule fois
    if (Store.get('eic_pn_prefilled') === '1') return;

    const gares = Data.getGares();
    if (gares.length === 0) return; // Pas de données chargées

    // Récupérer les éléments manuels existants pour ne pas les écraser
    let manual = [];
    try { manual = Store.getJSON('eic_manual_elements', []); } catch {}
    const manualIds = new Set(manual.map(m => m.id));

    // Récupérer les lignes depuis le layout pour associer les PN
    let linesByZone = new Map();
    try {
      const layout = Store.getJSON('eic_zone_layout', {});
      if (layout.tables) {
        layout.tables.forEach(t => (t.lines || []).forEach(line => {
          (line.zoneIds || []).forEach(zoneId => {
            if (!linesByZone.has(zoneId)) linesByZone.set(zoneId, []);
            linesByZone.get(zoneId).push(line.nom);
          });
        }));
      }
    } catch {}

    // Tous les PN extraits
    const allElements = Data.searchElementFuzzy('');
    const pns = allElements.filter(e => e.type === 'pn');
    if (pns.length === 0) return;

    let count = 0;
    pns.forEach(pn => {
      // Ne pas écraser un élément déjà calibré manuellement
      if (manualIds.has(pn.id)) return;

      // Trouver la gare la plus proche
      let closestGare = null;
      let minDist = Infinity;
      gares.forEach(g => {
        const dx = pn.x_pct - g.x_pct;
        const dy = pn.y_pct - g.y_pct;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < minDist) { minDist = dist; closestGare = g; }
      });

      if (!closestGare || minDist > 0.08) return;

      // Trouver la ligne associée via la zone de la gare
      const zoneLines = linesByZone.get(closestGare.zone_id) || [];
      const ligne = zoneLines[0] || '';

      // Extraire le type de PN depuis raw_text
      let pnType = pn.pn_type || '';

      const element = {
        id: pn.id,
        type: 'pn',
        identifiant: pn.identifiant,
        gare_id: closestGare.id,
        ligne: ligne,
        pk: pn.pk || '',
        secteur: pnType ? `PN ${pnType}` : '',
        x_pct: pn.x_pct,
        y_pct: pn.y_pct,
        source: 'prefilled',
        validated: false,
        pn_type: pnType,
      };

      Data.saveManualElement(element);
      count++;
    });

    Store.set('eic_pn_prefilled', '1');
    if (count > 0) {
      console.log(`Pré-remplissage: ${count} PN associés à leur gare et ligne`);
    }
  }

  // === PRÉ-REMPLISSAGE DES SECTEURS DANS LES LIGNES ===

  // Mapping officiel : numéro de ligne SNCF → secteurs traversés (dans l'ordre)
  // Basé sur la géographie réelle du réseau EIC Paris Nord
  const LINE_SECTOR_MAP = {
    // Ligne 272000 : Paris-Nord → Lille (via Creil, Chantilly, Longueau)
    '272000': ['paris', 'dionysien', 'goussainville-chantilly', 'creil', 'longueau'],
    // Ligne 330000 : St-Denis → Dieppe (via Enghien, Pontoise, Gisors)
    '330000': ['paris', 'dionysien', 'ermont-valmondois'],
    // Ligne 242000 : Creil → Jeumont (via Compiègne, Noyon, Tergnier)
    '242000': ['creil', 'compiegne', 'noyon', 'laon'],
    // Ligne 325000 : Épinay-Villetaneuse → Le Tréport-Mers (via Persan, Beauvais)
    '325000': ['dionysien', 'persan-boran', 'beauvais'],
    // Ligne 328000 : Ermont-Eaubonne → Valmondois
    '328000': ['ermont-valmondois'],
    // Ligne 229000 : La Plaine → Hirson (via Mitry, Crépy-en-Valois, Soissons)
    '229000': ['bourget-drancy', 'mitry', 'soissons'],
    // Ligne 311000 : Longueau → Boulogne (via Amiens)
    '311000': ['longueau'],
    // Ligne 017000 : Paris-Est / Grande Ceinture
    '017000': ['est'],
    // Ligne 340000 : Creil → Beauvais (via Hermes, Rochy-Condé)
    '340000': ['creil', 'beauvais'],
    // Ligne 262000 : Creil → Pontoise (via Précy, Boran, Persan)
    '262000': ['creil', 'persan-boran', 'ermont-valmondois'],
    // Ligne 267000 : Orry-la-Ville → Crépy-en-Valois
    '267000': ['goussainville-chantilly', 'mitry'],
    // Ligne 269000 : Chantilly → Creil
    '269000': ['goussainville-chantilly', 'creil'],
    // Ligne 254000 : Compiègne → Soissons
    '254000': ['compiegne', 'soissons'],
    // Ligne 247000 : Tergnier → Laon
    '247000': ['noyon', 'laon'],
    // Ligne 302000 : Amiens → Longueau / Tergnier
    '302000': ['longueau', 'noyon'],
    // Ligne 990000 : Grande Ceinture
    '990000': ['est', 'bourget-drancy'],
    // Ligne H — Tronc commun + Paris → Pontoise (via Ermont)
    'H-pontoise': ['paris', 'dionysien', 'ermont-valmondois'],
    // Ligne H — Paris → Luzarches (via Montsoult)
    'H-luzarches': ['paris', 'dionysien', 'goussainville-chantilly'],
    // Ligne H — Paris → Persan-Beaumont (via Valmondois)
    'H-persan': ['paris', 'dionysien', 'ermont-valmondois', 'persan-boran'],
    // Ligne H — Pontoise → Creil (transversale)
    'H-creil': ['ermont-valmondois', 'persan-boran', 'creil'],
    // Ligne H — complète (toutes branches)
    'ligne h': ['paris', 'dionysien', 'ermont-valmondois', 'persan-boran', 'goussainville-chantilly', 'creil'],
    // Ligne K Transilien — Paris → Crépy-en-Valois
    'K': ['paris', 'bourget-drancy', 'mitry'],
    // Ligne D RER — tronçon nord (Paris → Creil via Goussainville)
    'ligne d': ['paris', 'dionysien', 'goussainville-chantilly', 'creil'],
  };

  // Version du mapping — incrémenter pour forcer un re-remplissage
  const SECTOR_MAP_VERSION = '3';

  function prefillSectorsInLines() {
    if (Store.get('eic_sectors_prefilled') === SECTOR_MAP_VERSION) return;

    let layout;
    try { layout = Store.getJSON('eic_zone_layout', {}); } catch { return; }
    if (!layout || !layout.tables) return;

    const zones = Data.getZones();
    if (zones.length === 0) return;
    const zoneIds = new Set(zones.map(z => z.id));

    let changed = false;

    layout.tables.forEach(table => {
      (table.lines || []).forEach(line => {
        // Ne PAS toucher les lignes déjà remplies (manuellement ou précédemment)
        if (line.zoneIds && line.zoneIds.length > 0) return;

        // Extraire le numéro de ligne du nom (ex: "L272000 Paris-Nord → Lille" → "272000")
        const numMatch = line.nom.match(/\b(\d{6})\b/);
        const lineNum = numMatch ? numMatch[1] : null;

        // Chercher aussi par mot-clé Transilien (H-persan, H-pontoise, K)
        const nomLower = line.nom.toLowerCase();

        let sectors = null;

        if (lineNum && LINE_SECTOR_MAP[lineNum]) {
          sectors = LINE_SECTOR_MAP[lineNum];
        } else {
          // Recherche par mot-clé dans le nom
          for (const [key, secs] of Object.entries(LINE_SECTOR_MAP)) {
            if (nomLower.includes(key.toLowerCase())) {
              sectors = secs;
              break;
            }
          }
        }

        if (sectors) {
          // Filtrer pour ne garder que les secteurs qui existent
          const valid = sectors.filter(id => zoneIds.has(id));
          if (valid.length > 0) {
            line.zoneIds = valid;
            changed = true;
          }
        }
      });
    });

    if (changed) {
      Store.set('eic_zone_layout', layout);
      console.log('Pré-remplissage: secteurs assignés aux lignes depuis le référentiel SNCF');
      try { Search.reloadLayout(); } catch {}
    }

    Store.set('eic_sectors_prefilled', SECTOR_MAP_VERSION);
  }

  function populateLigneList() {
    const datalist = document.getElementById('calibrate-ligne-list');
    if (!datalist) return;
    datalist.innerHTML = '';

    // Collecter les noms de lignes depuis le layout + les lignes déjà saisies manuellement
    const lignes = new Set();

    // Depuis le layout (tables > lines)
    try {
      const layout = Store.getJSON('eic_zone_layout', {});
      if (layout.tables) {
        layout.tables.forEach(t => {
          (t.lines || []).forEach(l => {
            if (l.nom) lignes.add(l.nom);
          });
        });
      }
    } catch {}

    // Depuis les éléments manuels déjà calibrés
    try {
      const manual = Store.getJSON('eic_manual_elements', []);
      manual.forEach(m => {
        if (m.ligne) lignes.add(m.ligne);
      });
    } catch {}

    // Créer les options
    lignes.forEach(nom => {
      const opt = document.createElement('option');
      opt.value = nom;
      datalist.appendChild(opt);
    });
  }

  // hasSavedViewForId supprimé — utiliser Data.hasSavedView

  function isActive() { return active; }

  return { init, isActive };
})();
