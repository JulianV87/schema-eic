/**
 * Système d'annotations sur le schéma
 * Utilise un canvas overlay synchronisé avec OpenSeadragon
 */
const Annotations = (() => {
  let annotations = [];
  let activeTool = null;
  let nextId = 1;

  // Sélection / déplacement / redimensionnement d'annotations image
  let selectedAnnot = null;   // annotation sélectionnée
  let isDraggingAnnot = false;
  let dragAnnotOffset = null; // { dx, dy } offset du clic par rapport au centre
  let isResizingAnnot = false;
  let resizeAnnotHandle = null; // 'se','sw','ne','nw'
  let resizeAnnotOrigin = null;

  // Undo/Redo stacks
  let undoStack = [];
  let redoStack = [];
  const MAX_UNDO = 50;

  function pushUndo() {
    undoStack.push(JSON.stringify(annotations));
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack = []; // Toute nouvelle action efface le redo
  }

  function undo() {
    if (undoStack.length === 0) return;
    redoStack.push(JSON.stringify(annotations));
    annotations = JSON.parse(undoStack.pop());
    nextId = annotations.reduce((max, a) => Math.max(max, a.id), 0) + 1;
    redraw();
    saveToLocalStorage();
  }

  function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(JSON.stringify(annotations));
    annotations = JSON.parse(redoStack.pop());
    nextId = annotations.reduce((max, a) => Math.max(max, a.id), 0) + 1;
    redraw();
    saveToLocalStorage();
  }

  // Persistance Supabase via Store
  function saveToLocalStorage() {
    try {
      Store.set('eic_annotations', annotations);
      Store.set('eic_nextId', nextId);
    } catch {}
  }

  function loadFromLocalStorage() {
    try {
      const saved = Store.getJSON('eic_annotations', null);
      if (saved) {
        annotations = saved;
        nextId = Store.getJSON('eic_nextId', 1);
        if (isNaN(nextId)) nextId = annotations.reduce((max, a) => Math.max(max, a.id), 0) + 1;
        redraw();
      }
    } catch {}
  }

  // Types de symboles de train
  const TRAIN_SYMBOLS = {
    'train-immobilise': { symbol: '✕', color: '#ff4040', label: 'Immobilisé' },
    'train-retenu':     { symbol: '⏸', color: '#ff9520', label: 'Retenu à quai' },
    'train-arrete':     { symbol: '◆', color: '#9060ff', label: 'Arrêté PV' },
  };

  /**
   * Calculer le prochain numéro pour un type de tool donné
   */
  function getNextNumber(tool) {
    const existing = annotations.filter(a => a.tool === tool || a.type === tool);
    if (existing.length === 0) return 1;
    return Math.max(...existing.map(a => a.number || 0)) + 1;
  }

  // Couleurs des lignes de voie
  const VOIE_COLORS = {
    'voie-coupee':     '#ff4040',
    'ralentissement':  '#ff9520',
    'voie-libre':      '#00d4a0',
    'catenaire':       '#3080ff',
  };

  // Symboles ponctuels
  const MARKER_SYMBOLS = {
    'obstacle': { symbol: '▲', color: '#ff9520', label: 'Obstacle' },
    'danger':   { symbol: '⚠', color: '#ff4040', label: 'Danger' },
  };

  // Outils qui nécessitent 2 clics (point A → point B)
  const TWO_POINT_TOOLS = ['voie-coupee', 'ralentissement', 'voie-libre', 'catenaire'];

  // État pour les outils à 2 clics
  let pendingFirstPoint = null;

  // État pour le dessin libre
  let isDrawing = false;
  let drawPoints = [];

  function init() {
    // Charger annotations sauvegardées
    loadFromLocalStorage();

    // Ctrl+Z / Ctrl+Y
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if (e.ctrlKey && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    });

    // Bind tool buttons
    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tool = btn.dataset.tool;
        setActiveTool(tool === activeTool ? null : tool);
      });
    });

    // Clic sur le viewer → placer annotation
    const viewer = Viewer.getMainViewer();

    viewer.addHandler('canvas-click', (event) => {
      if (!activeTool) return;
      if (activeTool === 'magicwand') return;
      if (typeof Calibrate !== 'undefined' && Calibrate.isActive()) return;

      const viewportPoint = viewer.viewport.pointFromPixel(event.position);

      // Si on vient de finir un drag/resize, ne pas traiter le clic
      if (isDraggingAnnot || isResizingAnnot) return;

      // Vérifier si on clique sur une annotation image existante
      const hitAnnot = hitTestImageAnnotation(viewportPoint.x, viewportPoint.y);
      if (hitAnnot) {
        event.preventDefaultAction = true;
        selectedAnnot = hitAnnot;
        redraw();
        return;
      }

      // Désélectionner si on clique ailleurs — et ne PAS placer une nouvelle annotation
      if (selectedAnnot) {
        selectedAnnot = null;
        event.preventDefaultAction = true;
        redraw();
        return;
      }

      event.preventDefaultAction = true;

      // Outils train
      if (TRAIN_SYMBOLS[activeTool]) {
        promptTrainNumber((trainNumber) => {
          addTrainAnnotation(activeTool, viewportPoint.x, viewportPoint.y, trainNumber);
        });
      }
      // Outils ligne à 2 points (voie coupée, ralentissement, libérée, caténaire)
      else if (TWO_POINT_TOOLS.includes(activeTool)) {
        if (!pendingFirstPoint) {
          // Premier clic → stocker le point A
          pendingFirstPoint = { x: viewportPoint.x, y: viewportPoint.y };
          showStatusMessage('Cliquez le 2ème point');
        } else {
          // Deuxième clic → tracer la ligne
          addLineAnnotation(activeTool, pendingFirstPoint.x, pendingFirstPoint.y, viewportPoint.x, viewportPoint.y);
          pendingFirstPoint = null;
          hideStatusMessage();
        }
      }
      // Marqueurs ponctuels (obstacle, danger)
      else if (MARKER_SYMBOLS[activeTool]) {
        addMarkerAnnotation(activeTool, viewportPoint.x, viewportPoint.y, activeTool);
      }
      // Image depuis la bibliothèque
      else if (activeTool === 'image-library' && pendingImageSrc) {
        addImageAnnotation(viewportPoint.x, viewportPoint.y, pendingImageSrc, pendingImageLabel);
        hideStatusMessage();
        // Rester en mode placement pour poser plusieurs fois la même image
      }
      // Texte libre
      else if (activeTool === 'text') {
        const text = prompt('Texte :');
        if (text) addTextAnnotation(viewportPoint.x, viewportPoint.y, text);
      }
      // Annotations custom (symbole/point ou ligne)
      else if (activeTool && activeTool.startsWith('custom-')) {
        const idx = parseInt(activeTool.replace('custom-', ''), 10);
        const custom = customAnnotations[idx];
        if (!custom) return;

        if (custom.placement === 'line') {
          if (!pendingFirstPoint) {
            pendingFirstPoint = { x: viewportPoint.x, y: viewportPoint.y };
            showStatusMessage('Cliquez le 2ème point');
          } else {
            addLineAnnotation(activeTool, pendingFirstPoint.x, pendingFirstPoint.y, viewportPoint.x, viewportPoint.y);
            const lastAnnot = annotations[annotations.length - 1];
            lastAnnot.label = custom.name;
            lastAnnot.color = custom.color;
            lastAnnot.symbol = custom.symbol;
            pendingFirstPoint = null;
            hideStatusMessage();
            redraw();
          }
        } else {
          addMarkerAnnotation(activeTool, viewportPoint.x, viewportPoint.y, custom.name);
          const lastAnnot = annotations[annotations.length - 1];
          lastAnnot.symbol = custom.symbol;
          lastAnnot.color = custom.color;
          lastAnnot.label = custom.name;
          redraw();
        }
      }
    });

    // Dessin libre — mouse events sur le canvas d'annotations
    const viewerEl = document.getElementById('osd-viewer');

    viewer.addHandler('canvas-press', (event) => {
      if (activeTool !== 'draw') return;
      event.preventDefaultAction = true;
      isDrawing = true;
      const vp = viewer.viewport.pointFromPixel(event.position);
      drawPoints = [{ x: vp.x, y: vp.y }];
    });

    viewer.addHandler('canvas-drag', (event) => {
      if (!isDrawing || activeTool !== 'draw') return;
      event.preventDefaultAction = true;
      const vp = viewer.viewport.pointFromPixel(event.position);
      drawPoints.push({ x: vp.x, y: vp.y });
      redraw();
      // Dessiner le trait en cours
      drawLiveStroke();
    });

    viewer.addHandler('canvas-release', (event) => {
      if (!isDrawing || activeTool !== 'draw') return;
      isDrawing = false;
      if (drawPoints.length > 2) {
        addFreeDrawAnnotation(drawPoints);
      }
      drawPoints = [];
      redraw();
    });

    // Déplacement / redimensionnement d'annotations image
    viewer.addHandler('canvas-press', (event) => {
      if (!selectedAnnot) return;
      if (typeof Calibrate !== 'undefined' && Calibrate.isActive()) return;

      const vp = viewer.viewport.pointFromPixel(event.position);
      const imgW = (selectedAnnot.imgW || 60);
      const imgH = (selectedAnnot.imgH || 24);
      // Convertir taille pixels en viewport approximatif
      const vpSize = getAnnotViewportSize(selectedAnnot);

      // Tester les poignées de redimensionnement
      const handle = hitTestAnnotHandle(vp.x, vp.y, selectedAnnot, vpSize);
      if (handle) {
        event.preventDefaultAction = true;
        isResizingAnnot = true;
        resizeAnnotHandle = handle;
        resizeAnnotOrigin = { x: vp.x, y: vp.y, w: selectedAnnot.imgW || 60, h: selectedAnnot.imgH || 24 };
        return;
      }

      // Tester si on est sur l'annotation → déplacer
      if (isPointInAnnot(vp.x, vp.y, selectedAnnot, vpSize)) {
        event.preventDefaultAction = true;
        isDraggingAnnot = true;
        dragAnnotOffset = { dx: selectedAnnot.x - vp.x, dy: selectedAnnot.y - vp.y };
        pushUndo();
      }
    });

    viewer.addHandler('canvas-drag', (event) => {
      if (!isDraggingAnnot && !isResizingAnnot) return;
      event.preventDefaultAction = true;

      const vp = viewer.viewport.pointFromPixel(event.position);

      if (isDraggingAnnot && selectedAnnot) {
        selectedAnnot.x = vp.x + dragAnnotOffset.dx;
        selectedAnnot.y = vp.y + dragAnnotOffset.dy;
        redraw();
      } else if (isResizingAnnot && selectedAnnot && resizeAnnotOrigin) {
        const dx = vp.x - resizeAnnotOrigin.x;
        const dy = vp.y - resizeAnnotOrigin.y;
        // Calculer le facteur de scale en pixels
        const viewer = Viewer.getMainViewer();
        const p1 = viewer.viewport.viewportToViewerElementCoordinates(new OpenSeadragon.Point(0, 0));
        const p2 = viewer.viewport.viewportToViewerElementCoordinates(new OpenSeadragon.Point(dx, dy));
        const pxDx = p2.x - p1.x;
        const pxDy = p2.y - p1.y;

        // Resize proportionnel : utiliser le delta le plus grand
        const ratio = resizeAnnotOrigin.w / resizeAnnotOrigin.h;
        let delta = 0;
        if (resizeAnnotHandle.includes('e')) delta = pxDx;
        else if (resizeAnnotHandle.includes('w')) delta = -pxDx;
        else if (resizeAnnotHandle.includes('s')) delta = pxDy * ratio;
        else if (resizeAnnotHandle.includes('n')) delta = -pxDy * ratio;
        // Pour les coins, prendre le plus grand des deux
        if (resizeAnnotHandle.length === 2) {
          const dW = resizeAnnotHandle.includes('e') ? pxDx : -pxDx;
          const dH = (resizeAnnotHandle.includes('s') ? pxDy : -pxDy) * ratio;
          delta = Math.abs(dW) > Math.abs(dH) ? dW : dH;
        }

        const newW = Math.max(20, resizeAnnotOrigin.w + delta);
        const newH = Math.max(10, newW / ratio);

        selectedAnnot.imgW = Math.round(newW);
        selectedAnnot.imgH = Math.round(newH);
        redraw();
      }
    });

    viewer.addHandler('canvas-release', (event) => {
      if (isDraggingAnnot || isResizingAnnot) {
        isDraggingAnnot = false;
        isResizingAnnot = false;
        dragAnnotOffset = null;
        resizeAnnotHandle = null;
        resizeAnnotOrigin = null;
        saveToLocalStorage();
        redraw();
      }
    });

    // Clic droit sur le viewer container → menu contextuel complet
    const viewerContainer = document.getElementById('viewer-container');
    viewerContainer.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      closeContextMenu();

      const viewer = Viewer.getMainViewer();
      const viewerEl = document.getElementById('osd-viewer');
      const rect = viewerEl.getBoundingClientRect();
      const pixel = new OpenSeadragon.Point(e.clientX - rect.left, e.clientY - rect.top);
      const viewportPoint = viewer.viewport.pointFromPixel(pixel);

      showMainContextMenu(e.clientX, e.clientY, viewportPoint);
    });

    // Fermer le menu contextuel au clic ailleurs
    document.addEventListener('click', closeContextMenu);
  }

  function setActiveTool(tool) {
    // Désactiver la baguette magique et le mode calibration si on change d'outil
    if (activeTool === 'magicwand' && tool !== 'magicwand') {
      MagicWand.setActive(false);
    }
    if (typeof Calibrate !== 'undefined' && Calibrate.isActive() && tool) {
      // Désactiver le mode calibration
      const calBtn = document.getElementById('btn-calibrate');
      if (calBtn) { calBtn.classList.remove('active'); calBtn.click(); }
    }

    activeTool = tool;
    pendingFirstPoint = null;
    isDrawing = false;
    drawPoints = [];
    hideStatusMessage();
    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    });

    // Activer la baguette magique
    if (tool === 'magicwand') {
      MagicWand.setActive(true);
    }

    const osd = document.getElementById('osd-viewer');
    osd.style.cursor = tool ? 'crosshair' : '';
  }

  function getActiveTool() { return activeTool; }

  function showStatusMessage(msg) {
    let el = document.getElementById('status-message');
    if (!el) {
      el = document.createElement('div');
      el.id = 'status-message';
      el.style.cssText = `position:absolute; top:8px; left:50%; transform:translateX(-50%); z-index:30;
        background:rgba(48,128,255,0.9); color:#fff; font-family:'JetBrains Mono',monospace;
        font-size:11px; padding:4px 14px; border-radius:4px; pointer-events:none;`;
      document.getElementById('viewer-container').appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
  }

  function hideStatusMessage() {
    const el = document.getElementById('status-message');
    if (el) el.style.display = 'none';
  }

  /**
   * Ajouter un cercle rouge sur un élément infra
   */
  function highlightElement(element, message) {
    const annotation = {
      id: nextId++,
      type: 'element-highlight',
      x: element.x_pct,
      y: element.y_pct,
      elementId: element.id,
      identifiant: element.identifiant,
      message: message || '',
      color: '#ff4040',
    };
    pushUndo();
    annotations.push(annotation);
    redraw();
    saveToLocalStorage();

    // Marquer dans le sidebar
    const sidebarItem = document.querySelector(`.sidebar-item[data-id="${element.id}"]`);
    if (sidebarItem) sidebarItem.classList.add('annotated');

    return annotation;
  }

  /**
   * Ajouter un symbole de train
   */
  function addTrainAnnotation(tool, x, y, trainNumber) {
    const config = TRAIN_SYMBOLS[tool];
    const num = getNextNumber(tool);
    const annotation = {
      id: nextId++,
      type: 'train',
      tool: tool,
      number: num,
      x: x,
      y: y,
      trainNumber: trainNumber,
      symbol: config.symbol,
      color: config.color,
      label: config.label,
    };
    pushUndo();
    annotations.push(annotation);
    redraw();
    saveToLocalStorage();
    return annotation;
  }

  /**
   * Ajouter un texte libre
   */
  function addTextAnnotation(x, y, text) {
    const annotation = {
      id: nextId++,
      type: 'text',
      x: x,
      y: y,
      text: text,
      color: '#ffffff',
    };
    pushUndo();
    annotations.push(annotation);
    redraw();
    saveToLocalStorage();
    return annotation;
  }

  /**
   * Ajouter une annotation image (ex: machine de secours)
   */
  function addImageAnnotation(x, y, src, label) {
    const num = getNextNumber('image');
    const annotation = {
      id: nextId++,
      type: 'image',
      x: x,
      y: y,
      src: src,
      label: label || '',
      color: '#00a550',
      number: num,
    };
    pushUndo();
    annotations.push(annotation);
    redraw();
    saveToLocalStorage();
    return annotation;
  }

  /**
   * Ajouter un marqueur générique
   */
  function addMarkerAnnotation(tool, x, y, label) {
    const config = MARKER_SYMBOLS[tool];
    const num = getNextNumber(tool);
    const annotation = {
      id: nextId++,
      type: 'marker',
      tool: tool,
      number: num,
      x: x,
      y: y,
      symbol: config ? config.symbol : '●',
      color: config ? config.color : (VOIE_COLORS[tool] || '#ffffff'),
      label: config ? config.label : (label || tool),
    };
    pushUndo();
    annotations.push(annotation);
    redraw();
    saveToLocalStorage();
    return annotation;
  }

  /**
   * Ajouter une ligne entre deux points (voie coupée, ralentissement, caténaire...)
   */
  function addLineAnnotation(tool, x1, y1, x2, y2) {
    const labels = {
      'voie-coupee': 'Voie coupée',
      'ralentissement': 'Ralentissement',
      'voie-libre': 'Voie libérée',
      'catenaire': 'Absence de tension',
    };
    const num = getNextNumber(tool);
    const annotation = {
      id: nextId++,
      type: 'line',
      tool: tool,
      number: num,
      x: (x1 + x2) / 2,
      y: (y1 + y2) / 2,
      x1: x1, y1: y1,
      x2: x2, y2: y2,
      color: VOIE_COLORS[tool] || '#ffffff',
      label: (labels[tool] || tool) + ' #' + num,
    };
    pushUndo();
    annotations.push(annotation);
    redraw();
    saveToLocalStorage();
    return annotation;
  }

  /**
   * Ajouter un dessin libre (suite de points)
   */
  function addFreeDrawAnnotation(points) {
    const annotation = {
      id: nextId++,
      type: 'freedraw',
      x: points[0].x,
      y: points[0].y,
      points: points.map(p => ({ x: p.x, y: p.y })),
      color: '#ffffff',
      label: 'Dessin libre',
    };
    pushUndo();
    annotations.push(annotation);
    redraw();
    saveToLocalStorage();
    return annotation;
  }

  /**
   * Dessiner le trait en cours pendant le dessin libre
   */
  function drawLiveStroke() {
    if (drawPoints.length < 2) return;
    const canvas = document.getElementById('annotation-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    ctx.beginPath();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const first = Viewer.schemaToScreen(drawPoints[0].x, drawPoints[0].y);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < drawPoints.length; i++) {
      const p = Viewer.schemaToScreen(drawPoints[i].x, drawPoints[i].y);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  /**
   * Menu contextuel principal — clic droit n'importe où
   */
  function showMainContextMenu(screenX, screenY, viewportPoint) {
    const menu = document.createElement('div');
    menu.id = 'annotation-context-menu';
    menu.style.cssText = `
      position:fixed; left:${screenX}px; top:${screenY}px; z-index:300;
      background:#0c1220; border:1px solid #2a4266; border-radius:6px;
      box-shadow:0 8px 24px rgba(0,0,0,0.6); overflow:hidden;
      font-family:'JetBrains Mono',monospace; font-size:11px;
      min-width:200px; max-height:70vh; overflow-y:auto;
    `;

    // === SECTION AJOUTER ===
    const addTitle = document.createElement('div');
    addTitle.style.cssText = 'padding:6px 12px; color:#00d4a0; font-size:9px; letter-spacing:1px; text-transform:uppercase; border-bottom:1px solid #1e304a;';
    addTitle.textContent = 'Ajouter ici';
    menu.appendChild(addTitle);

    const addOptions = [
      { label: 'Train immobilisé', icon: '✕', color: '#ff4040', tool: 'train-immobilise' },
      { label: 'Train retenu à quai', icon: '⏸', color: '#ff9520', tool: 'train-retenu' },
      { label: 'Train arrêté PV', icon: '◆', color: '#9060ff', tool: 'train-arrete' },
      { label: 'Obstacle', icon: '▲', color: '#ff9520', tool: 'obstacle' },
      { label: 'Danger', icon: '⚠', color: '#ff4040', tool: 'danger' },
      { label: 'Voie coupée (2 pts)', icon: '━', color: '#ff4040', tool: 'voie-coupee' },
      { label: 'Ralentissement (2 pts)', icon: '━', color: '#ff9520', tool: 'ralentissement' },
      { label: 'Voie libérée (2 pts)', icon: '━', color: '#00d4a0', tool: 'voie-libre' },
      { label: 'Caténaire (2 pts)', icon: '━', color: '#3080ff', tool: 'catenaire' },
      { label: 'Texte libre', icon: 'T', color: '#c8daf5', tool: 'text' },
      { label: 'Image / Custom...', icon: '🖼', color: '#c8daf5', tool: 'open-manager' },
    ];

    addOptions.forEach(opt => {
      const item = createMenuItem(opt.icon, opt.label, opt.color, () => {
        closeContextMenu();
        if (opt.tool === 'open-manager') {
          showAnnotationManager();
        } else if (TRAIN_SYMBOLS[opt.tool]) {
          promptTrainNumber((num) => {
            addTrainAnnotation(opt.tool, viewportPoint.x, viewportPoint.y, num);
          });
        } else if (TWO_POINT_TOOLS.includes(opt.tool)) {
          setActiveTool(opt.tool);
          pendingFirstPoint = { x: viewportPoint.x, y: viewportPoint.y };
          showStatusMessage('Cliquez le 2ème point pour tracer la ligne');
        } else if (MARKER_SYMBOLS[opt.tool]) {
          addMarkerAnnotation(opt.tool, viewportPoint.x, viewportPoint.y, opt.tool);
        } else if (opt.tool === 'text') {
          const text = prompt('Texte :');
          if (text) addTextAnnotation(viewportPoint.x, viewportPoint.y, text);
        }
      });
      menu.appendChild(item);
    });

    // === SECTION ANNOTATIONS EXISTANTES ===
    if (annotations.length > 0) {
      const listTitle = document.createElement('div');
      listTitle.style.cssText = 'padding:6px 12px; color:#3080ff; font-size:9px; letter-spacing:1px; text-transform:uppercase; border-top:1px solid #1e304a; border-bottom:1px solid #1e304a; margin-top:2px;';
      listTitle.textContent = `Annotations (${annotations.length})`;
      menu.appendChild(listTitle);

      annotations.forEach(a => {
        const label = getAnnotationLabel(a);
        const icon = getAnnotationIcon(a);

        const item = document.createElement('div');
        item.style.cssText = 'padding:6px 12px; cursor:pointer; color:#c8daf5; display:flex; align-items:center; justify-content:space-between; gap:8px; transition:background 0.1s;';

        const labelSpan = document.createElement('span');
        labelSpan.style.cssText = 'display:flex; align-items:center; gap:6px; flex:1; min-width:0; overflow:hidden;';
        labelSpan.innerHTML = `<span style="color:${a.color || '#c8daf5'}; font-size:13px; flex-shrink:0;">${icon}</span><span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${label}</span>`;

        const actions = document.createElement('span');
        actions.style.cssText = 'display:flex; gap:2px; flex-shrink:0;';

        const editBtn = document.createElement('span');
        editBtn.textContent = '✎';
        editBtn.title = 'Modifier';
        editBtn.style.cssText = 'cursor:pointer; padding:2px 5px; border-radius:3px; color:#3080ff; font-size:12px;';
        editBtn.addEventListener('mouseenter', () => { editBtn.style.background = '#162038'; });
        editBtn.addEventListener('mouseleave', () => { editBtn.style.background = 'none'; });
        editBtn.addEventListener('click', (ev) => { ev.stopPropagation(); closeContextMenu(); editAnnotation(a); });

        const delBtn = document.createElement('span');
        delBtn.textContent = '✕';
        delBtn.title = 'Supprimer';
        delBtn.style.cssText = 'cursor:pointer; padding:2px 5px; border-radius:3px; color:#ff4040; font-size:12px;';
        delBtn.addEventListener('mouseenter', () => { delBtn.style.background = '#162038'; });
        delBtn.addEventListener('mouseleave', () => { delBtn.style.background = 'none'; });
        delBtn.addEventListener('click', (ev) => { ev.stopPropagation(); closeContextMenu(); remove(a.id); });

        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
        item.appendChild(labelSpan);
        item.appendChild(actions);

        item.addEventListener('mouseenter', () => { item.style.background = '#111a2e'; });
        item.addEventListener('mouseleave', () => { item.style.background = 'none'; });
        item.addEventListener('click', (ev) => { ev.stopPropagation(); closeContextMenu(); Viewer.panTo(a.x, a.y, 8); });

        menu.appendChild(item);
      });

      // Tout effacer
      const clearItem = createMenuItem('✕', 'Tout effacer', '#ff4040', () => { closeContextMenu(); clear(); });
      clearItem.style.borderTop = '1px solid #1e304a';
      clearItem.style.marginTop = '2px';
      menu.appendChild(clearItem);
    }

    document.body.appendChild(menu);

    // S'assurer que le menu reste dans l'écran
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth) menu.style.left = (screenX - menuRect.width) + 'px';
    if (menuRect.bottom > window.innerHeight) menu.style.top = (screenY - menuRect.height) + 'px';
  }

  function createMenuItem(icon, label, color, action) {
    const item = document.createElement('div');
    item.style.cssText = `padding:7px 12px; cursor:pointer; color:${color || '#c8daf5'}; display:flex; align-items:center; gap:8px; transition:background 0.1s;`;
    item.innerHTML = `<span style="width:14px; text-align:center; font-size:13px;">${icon}</span> ${label}`;
    item.addEventListener('mouseenter', () => { item.style.background = '#111a2e'; });
    item.addEventListener('mouseleave', () => { item.style.background = 'none'; });
    item.addEventListener('click', (e) => { e.stopPropagation(); action(); });
    return item;
  }

  /**
   * Menu contextuel sur une annotation (clic droit proche)
   */
  function showContextMenu(x, y, annotation) {
    const menu = document.createElement('div');
    menu.id = 'annotation-context-menu';
    menu.style.cssText = `
      position:fixed; left:${x}px; top:${y}px; z-index:300;
      background:#0c1220; border:1px solid #2a4266; border-radius:6px;
      box-shadow:0 8px 24px rgba(0,0,0,0.6); overflow:hidden;
      font-family:'JetBrains Mono',monospace; font-size:11px;
    `;

    // Titre
    const title = document.createElement('div');
    title.style.cssText = 'padding:6px 12px; color:#4a6a9a; font-size:9px; letter-spacing:1px; text-transform:uppercase; border-bottom:1px solid #1e304a;';
    title.textContent = annotation.identifiant || annotation.trainNumber || annotation.type;
    menu.appendChild(title);

    // Options
    const options = [];

    if (annotation.type === 'train') {
      options.push({ label: 'Modifier n° train', icon: '✎', action: () => {
        closeContextMenu();
        promptTrainNumber((num) => {
          annotation.trainNumber = num;
          redraw();
        });
      }});
    }

    if (annotation.type === 'element-highlight') {
      options.push({ label: 'Modifier message', icon: '✎', action: () => {
        closeContextMenu();
        const msg = prompt('Message :', annotation.message || '');
        if (msg !== null) {
          annotation.message = msg;
          redraw();
        }
      }});
    }

    if (annotation.type === 'text') {
      options.push({ label: 'Modifier texte', icon: '✎', action: () => {
        closeContextMenu();
        const txt = prompt('Texte :', annotation.text || '');
        if (txt !== null) {
          annotation.text = txt;
          redraw();
        }
      }});
    }

    // Modifier apparence (pour tous les types sauf freedraw)
    if (annotation.type !== 'freedraw') {
      options.push({ label: 'Modifier apparence', icon: '🎨', action: () => {
        closeContextMenu();
        showEditAnnotationForm(annotation);
      }});
    }

    options.push({ label: 'Supprimer', icon: '✕', color: '#ff4040', action: () => {
      closeContextMenu();
      remove(annotation.id);
    }});

    options.forEach(opt => {
      const item = document.createElement('div');
      item.style.cssText = `padding:8px 12px; cursor:pointer; color:${opt.color || '#c8daf5'}; display:flex; align-items:center; gap:8px; transition:background 0.1s;`;
      item.innerHTML = `<span style="width:14px;text-align:center">${opt.icon}</span> ${opt.label}`;
      item.addEventListener('mouseenter', () => { item.style.background = '#111a2e'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'none'; });
      item.addEventListener('click', (e) => { e.stopPropagation(); opt.action(); });
      menu.appendChild(item);
    });

    document.body.appendChild(menu);

    // S'assurer que le menu reste dans l'écran
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth) menu.style.left = (x - menuRect.width) + 'px';
    if (menuRect.bottom > window.innerHeight) menu.style.top = (y - menuRect.height) + 'px';
  }

  /**
   * Menu liste de toutes les annotations (clic droit loin d'une annotation)
   */
  function showAnnotationListMenu(x, y) {
    if (annotations.length === 0) return;

    const menu = document.createElement('div');
    menu.id = 'annotation-context-menu';
    menu.style.cssText = `
      position:fixed; left:${x}px; top:${y}px; z-index:300;
      background:#0c1220; border:1px solid #2a4266; border-radius:6px;
      box-shadow:0 8px 24px rgba(0,0,0,0.6); overflow:hidden;
      font-family:'JetBrains Mono',monospace; font-size:11px;
      max-height:400px; overflow-y:auto;
    `;

    // Titre
    const title = document.createElement('div');
    title.style.cssText = 'padding:6px 12px; color:#4a6a9a; font-size:9px; letter-spacing:1px; text-transform:uppercase; border-bottom:1px solid #1e304a;';
    title.textContent = `Annotations (${annotations.length})`;
    menu.appendChild(title);

    // Lister chaque annotation
    annotations.forEach(a => {
      const label = getAnnotationLabel(a);
      const color = a.color || '#c8daf5';

      const item = document.createElement('div');
      item.style.cssText = `padding:6px 12px; cursor:pointer; color:#c8daf5; display:flex; align-items:center; justify-content:space-between; gap:12px; transition:background 0.1s; border-bottom:1px solid #1e304a;`;

      const labelSpan = document.createElement('span');
      labelSpan.style.cssText = `display:flex; align-items:center; gap:6px; flex:1; min-width:0;`;
      labelSpan.innerHTML = `<span style="color:${color}; font-size:14px;">${getAnnotationIcon(a)}</span> <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${label}</span>`;

      const actions = document.createElement('span');
      actions.style.cssText = 'display:flex; gap:4px; flex-shrink:0;';

      // Bouton éditer
      const editBtn = document.createElement('span');
      editBtn.textContent = '✎';
      editBtn.title = 'Modifier';
      editBtn.style.cssText = 'cursor:pointer; padding:2px 4px; border-radius:3px; color:#3080ff;';
      editBtn.addEventListener('mouseenter', () => { editBtn.style.background = '#162038'; });
      editBtn.addEventListener('mouseleave', () => { editBtn.style.background = 'none'; });
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeContextMenu();
        editAnnotation(a);
      });

      // Bouton supprimer
      const delBtn = document.createElement('span');
      delBtn.textContent = '✕';
      delBtn.title = 'Supprimer';
      delBtn.style.cssText = 'cursor:pointer; padding:2px 4px; border-radius:3px; color:#ff4040;';
      delBtn.addEventListener('mouseenter', () => { delBtn.style.background = '#162038'; });
      delBtn.addEventListener('mouseleave', () => { delBtn.style.background = 'none'; });
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeContextMenu();
        remove(a.id);
      });

      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      item.appendChild(labelSpan);
      item.appendChild(actions);

      // Clic sur la ligne → centrer la vue sur l'annotation
      item.addEventListener('mouseenter', () => { item.style.background = '#111a2e'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'none'; });
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        closeContextMenu();
        Viewer.panTo(a.x, a.y, 8);
      });

      menu.appendChild(item);
    });

    document.body.appendChild(menu);

    // S'assurer que le menu reste dans l'écran
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth) menu.style.left = (x - menuRect.width) + 'px';
    if (menuRect.bottom > window.innerHeight) menu.style.top = (y - menuRect.height) + 'px';
  }

  function getAnnotationLabel(a) {
    const num = a.number ? ` #${a.number}` : '';
    switch (a.type) {
      case 'train': return `${TRAIN_SYMBOLS[a.tool]?.label || 'Train'}${num} — ${a.trainNumber || '?'}`;
      case 'element-highlight': return `${a.identifiant || 'Element'} ${a.message ? '— ' + a.message : ''}`;
      case 'text': return a.text || 'Texte';
      case 'marker': return `${a.label || 'Marqueur'}${num}`;
      case 'line': return a.label || 'Ligne';
      case 'freedraw': return 'Dessin libre';
      case 'image': return `${a.label || 'Image'}${num}`;
      default: return 'Annotation';
    }
  }

  function getAnnotationIcon(a) {
    switch (a.type) {
      case 'train': return TRAIN_SYMBOLS[a.tool]?.symbol || '●';
      case 'element-highlight': return '⊙';
      case 'text': return 'T';
      case 'marker': return a.symbol || '●';
      case 'line': return '━';
      case 'freedraw': return '✏';
      case 'image': return '🚂';
      default: return '●';
    }
  }

  function editAnnotation(a) {
    if (a.type === 'train') {
      promptTrainNumber((num) => { pushUndo(); a.trainNumber = num; redraw(); saveToLocalStorage(); });
    } else if (a.type === 'element-highlight') {
      const msg = prompt('Message :', a.message || '');
      if (msg !== null) { pushUndo(); a.message = msg; redraw(); saveToLocalStorage(); }
    } else if (a.type === 'text') {
      const txt = prompt('Texte :', a.text || '');
      if (txt !== null) { pushUndo(); a.text = txt; redraw(); saveToLocalStorage(); }
    } else if (a.type === 'marker' || a.type === 'line') {
      showEditAnnotationForm(a);
    }
  }

  /**
   * Formulaire d'édition avancé pour une annotation (symbole, couleur, label)
   */
  function showEditAnnotationForm(a) {
    const symbols = ['●','▲','■','◆','★','✕','⚠','⛔','🔥','⚡','💧','🚧','🚂','👤','📍','⊘'];
    const colors = ['#ff4040','#ff9520','#ffdd00','#00d4a0','#3080ff','#9060ff','#ff40a0','#ffffff'];

    let selectedSymbol = a.symbol || '●';
    let selectedColor = a.color || '#ff4040';

    const menu = document.createElement('div');
    menu.id = 'annotation-context-menu';
    menu.style.cssText = `
      position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:300;
      background:#0c1220; border:1px solid #2a4266; border-radius:8px;
      box-shadow:0 8px 24px rgba(0,0,0,0.6);
      font-family:'JetBrains Mono',monospace; font-size:11px;
      padding:16px; min-width:250px;
    `;

    menu.innerHTML = `
      <div style="color:#4a6a9a;font-size:9px;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Modifier annotation</div>
      <div style="margin-bottom:8px;">
        <div style="color:#4a6a9a;font-size:9px;margin-bottom:4px;">NOM</div>
        <input id="edit-annot-label" type="text" value="${a.label || ''}" style="width:100%;padding:4px 8px;background:#111a2e;border:1px solid #1e304a;border-radius:3px;color:#c8daf5;font-family:inherit;font-size:11px;outline:none;">
      </div>
      <div style="margin-bottom:8px;">
        <div style="color:#4a6a9a;font-size:9px;margin-bottom:4px;">SYMBOLE</div>
        <div id="edit-annot-symbols" style="display:flex;flex-wrap:wrap;gap:3px;"></div>
      </div>
      <div style="margin-bottom:10px;">
        <div style="color:#4a6a9a;font-size:9px;margin-bottom:4px;">COULEUR</div>
        <div id="edit-annot-colors" style="display:flex;gap:4px;"></div>
      </div>
      <div style="display:flex;gap:8px;">
        <button id="edit-annot-save" style="flex:1;padding:6px;background:#00d4a0;border:none;border-radius:4px;color:#06090f;font-family:inherit;font-weight:600;cursor:pointer;">OK</button>
        <button id="edit-annot-cancel" style="flex:1;padding:6px;background:#111a2e;border:1px solid #1e304a;border-radius:4px;color:#c8daf5;font-family:inherit;cursor:pointer;">Annuler</button>
      </div>
    `;

    document.body.appendChild(menu);

    // Symboles
    const symContainer = document.getElementById('edit-annot-symbols');
    symbols.forEach(s => {
      const btn = document.createElement('span');
      btn.textContent = s;
      btn.style.cssText = `width:26px;height:26px;display:flex;align-items:center;justify-content:center;background:#111a2e;border:1px solid ${s === selectedSymbol ? '#00d4a0' : '#1e304a'};border-radius:3px;cursor:pointer;font-size:14px;`;
      btn.addEventListener('click', () => {
        selectedSymbol = s;
        symContainer.querySelectorAll('span').forEach(b => b.style.borderColor = '#1e304a');
        btn.style.borderColor = '#00d4a0';
      });
      symContainer.appendChild(btn);
    });

    // Couleurs
    const colContainer = document.getElementById('edit-annot-colors');
    colors.forEach(c => {
      const btn = document.createElement('span');
      btn.style.cssText = `width:22px;height:22px;border-radius:50%;background:${c};border:2px solid ${c === selectedColor ? '#fff' : '#1e304a'};cursor:pointer;`;
      btn.addEventListener('click', () => {
        selectedColor = c;
        colContainer.querySelectorAll('span').forEach(b => b.style.borderColor = '#1e304a');
        btn.style.borderColor = '#fff';
      });
      colContainer.appendChild(btn);
    });

    // Save
    document.getElementById('edit-annot-save').addEventListener('click', () => {
      pushUndo();
      a.symbol = selectedSymbol;
      a.color = selectedColor;
      a.label = document.getElementById('edit-annot-label').value.trim() || a.label;
      menu.remove();
      redraw();
      saveToLocalStorage();
    });

    // Cancel
    document.getElementById('edit-annot-cancel').addEventListener('click', () => { menu.remove(); });
  }

  function closeContextMenu() {
    const existing = document.getElementById('annotation-context-menu');
    if (existing) existing.remove();
  }

  /**
   * Supprimer une annotation
   */
  function remove(id) {
    pushUndo();
    annotations = annotations.filter(a => a.id !== id);
    redraw();
    saveToLocalStorage();
  }

  /**
   * Tout effacer
   */
  function clear() {
    pushUndo();
    annotations = [];
    document.querySelectorAll('.sidebar-item.annotated').forEach(el => el.classList.remove('annotated'));
    closeContextMenu();
    redraw();
    saveToLocalStorage();
  }

  /**
   * Redessiner toutes les annotations sur le canvas overlay
   */
  function redraw() {
    const canvas = document.getElementById('annotation-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    annotations.forEach(a => {
      const screen = Viewer.schemaToScreen(a.x, a.y);

      switch (a.type) {
        case 'element-highlight':
          drawElementHighlight(ctx, screen, a);
          break;
        case 'train':
          drawTrainSymbol(ctx, screen, a);
          break;
        case 'text':
          drawText(ctx, screen, a);
          break;
        case 'marker':
          drawMarker(ctx, screen, a);
          break;
        case 'line':
          drawLine(ctx, a);
          break;
        case 'freedraw':
          drawFreeDraw(ctx, a);
          break;
        case 'image':
          drawImageAnnotation(ctx, screen, a);
          break;
      }
    });
  }

  // Polyfill roundRect pour navigateurs anciens
  function roundRect(ctx, x, y, w, h, r) {
    if (ctx.roundRect) {
      ctx.roundRect(x, y, w, h, r);
    } else {
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.arcTo(x + w, y, x + w, y + r, r);
      ctx.lineTo(x + w, y + h - r);
      ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
      ctx.lineTo(x + r, y + h);
      ctx.arcTo(x, y + h, x, y + h - r, r);
      ctx.lineTo(x, y + r);
      ctx.arcTo(x, y, x + r, y, r);
    }
  }

  function drawElementHighlight(ctx, pos, annotation) {
    ctx.save();
    const r = 18;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = annotation.color;
    ctx.lineWidth = 3;
    ctx.stroke();

    if (annotation.message) {
      ctx.font = '11px "JetBrains Mono", monospace';
      const metrics = ctx.measureText(annotation.message);
      const padding = 4;
      const bgWidth = metrics.width + padding * 2;
      const bgHeight = 16;

      ctx.fillStyle = 'rgba(255,64,64,0.85)';
      ctx.beginPath();
      roundRect(ctx, pos.x + r + 6, pos.y - bgHeight / 2, bgWidth, bgHeight, 3);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.fillText(annotation.message, pos.x + r + 6 + padding, pos.y + 4);
    }
    ctx.restore();
  }

  function drawTrainSymbol(ctx, pos, annotation) {
    ctx.save();
    ctx.textAlign = 'center';

    // Numéro d'ordre (pastille en haut à droite)
    if (annotation.number) {
      ctx.font = 'bold 10px "JetBrains Mono", monospace';
      ctx.fillStyle = annotation.color;
      ctx.beginPath();
      ctx.arc(pos.x + 14, pos.y - 8, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(annotation.number), pos.x + 14, pos.y - 5);
    }

    // Symbole principal
    ctx.font = 'bold 22px sans-serif';
    ctx.fillStyle = annotation.color;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 4;
    ctx.fillText(annotation.symbol, pos.x, pos.y + 8);
    ctx.shadowBlur = 0;

    // Numéro de train en dessous
    if (annotation.trainNumber) {
      ctx.font = '10px "JetBrains Mono", monospace';
      const label = annotation.trainNumber;
      const metrics = ctx.measureText(label);
      const padding = 3;

      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.beginPath();
      roundRect(ctx, pos.x - metrics.width / 2 - padding, pos.y + 14, metrics.width + padding * 2, 14, 2);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, pos.x, pos.y + 25);
    }
    ctx.restore();
  }

  function drawText(ctx, pos, annotation) {
    ctx.save();
    ctx.font = '12px "JetBrains Mono", monospace';
    const metrics = ctx.measureText(annotation.text);
    const padding = 4;

    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.beginPath();
    roundRect(ctx, pos.x - padding, pos.y - 12, metrics.width + padding * 2, 18, 3);
    ctx.fill();

    ctx.fillStyle = annotation.color;
    ctx.fillText(annotation.text, pos.x, pos.y);
    ctx.restore();
  }

  function drawMarker(ctx, pos, annotation) {
    ctx.save();
    ctx.textAlign = 'center';

    // Numéro d'ordre (pastille en haut à droite)
    if (annotation.number) {
      ctx.font = 'bold 10px "JetBrains Mono", monospace';
      ctx.fillStyle = annotation.color;
      ctx.beginPath();
      ctx.arc(pos.x + 14, pos.y - 8, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(annotation.number), pos.x + 14, pos.y - 5);
    }

    // Symbole
    const symbol = annotation.symbol || '●';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillStyle = annotation.color;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 4;
    ctx.fillText(symbol, pos.x, pos.y + 7);
    ctx.shadowBlur = 0;

    // Label en dessous
    if (annotation.label) {
      ctx.font = '9px "JetBrains Mono", monospace';
      const metrics = ctx.measureText(annotation.label);
      const pad = 3;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.beginPath();
      roundRect(ctx, pos.x - metrics.width / 2 - pad, pos.y + 14, metrics.width + pad * 2, 13, 2);
      ctx.fill();
      ctx.fillStyle = annotation.color;
      ctx.fillText(annotation.label, pos.x, pos.y + 24);
    }
    ctx.restore();
  }

  function drawLine(ctx, annotation) {
    ctx.save();
    const p1 = Viewer.schemaToScreen(annotation.x1, annotation.y1);
    const p2 = Viewer.schemaToScreen(annotation.x2, annotation.y2);

    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.strokeStyle = annotation.color;
    ctx.lineWidth = 6;
    ctx.globalAlpha = 0.6;
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineWidth = 2;
    ctx.stroke();

    [p1, p2].forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = annotation.color;
      ctx.fill();
    });

    const cx = (p1.x + p2.x) / 2;
    const cy = (p1.y + p2.y) / 2;
    ctx.font = '9px "JetBrains Mono", monospace';
    const metrics = ctx.measureText(annotation.label || '');
    const pad = 4;
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.beginPath();
    roundRect(ctx, cx - metrics.width / 2 - pad, cy - 7, metrics.width + pad * 2, 14, 3);
    ctx.fill();
    ctx.fillStyle = annotation.color;
    ctx.textAlign = 'center';
    ctx.fillText(annotation.label || '', cx, cy + 3);
    ctx.restore();
  }

  function drawFreeDraw(ctx, annotation) {
    if (!annotation.points || annotation.points.length < 2) return;
    ctx.save();
    ctx.strokeStyle = annotation.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();

    const first = Viewer.schemaToScreen(annotation.points[0].x, annotation.points[0].y);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < annotation.points.length; i++) {
      const p = Viewer.schemaToScreen(annotation.points[i].x, annotation.points[i].y);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // === Interaction annotations image ===

  function getAnnotViewportSize(a) {
    // Convertir la taille pixel en viewport (approximatif)
    const viewer = Viewer.getMainViewer();
    if (!viewer) return { w: 0.01, h: 0.005 };
    const w = a.imgW || 60;
    const h = a.imgH || 24;
    const c = viewer.viewport.viewportToViewerElementCoordinates(new OpenSeadragon.Point(a.x, a.y));
    const c2 = viewer.viewport.pointFromPixel(new OpenSeadragon.Point(c.x + w, c.y + h));
    return { w: c2.x - a.x, h: c2.y - a.y };
  }

  function isPointInAnnot(px, py, a, vpSize) {
    const hw = vpSize.w / 2;
    const hh = vpSize.h / 2;
    return px >= a.x - hw && px <= a.x + hw && py >= a.y - hh && py <= a.y + hh;
  }

  function hitTestImageAnnotation(px, py) {
    // Parcourir en ordre inverse (dernier placé = au-dessus)
    for (let i = annotations.length - 1; i >= 0; i--) {
      const a = annotations[i];
      if (a.type !== 'image') continue;
      const vpSize = getAnnotViewportSize(a);
      if (isPointInAnnot(px, py, a, vpSize)) return a;
    }
    return null;
  }

  function hitTestAnnotHandle(px, py, a, vpSize) {
    const hw = vpSize.w / 2;
    const hh = vpSize.h / 2;
    const tol = vpSize.w * 0.15; // tolérance proportionnelle
    const corners = {
      nw: { x: a.x - hw, y: a.y - hh },
      ne: { x: a.x + hw, y: a.y - hh },
      sw: { x: a.x - hw, y: a.y + hh },
      se: { x: a.x + hw, y: a.y + hh },
    };
    for (const [name, pos] of Object.entries(corners)) {
      if (Math.abs(px - pos.x) < tol && Math.abs(py - pos.y) < tol) return name;
    }
    return null;
  }

  // Cache des images chargées
  const imageCache = {};

  function drawImageAnnotation(ctx, pos, annotation) {
    const imgW = annotation.imgW || 60;
    const imgH = annotation.imgH || 24;
    const x = pos.x - imgW / 2;
    const y = pos.y - imgH / 2;
    const isSel = selectedAnnot && selectedAnnot.id === annotation.id;

    // Charger l'image (mise en cache)
    if (!imageCache[annotation.src]) {
      const img = new Image();
      img.src = annotation.src;
      img.onload = () => {
        imageCache[annotation.src] = img;
        redraw();
      };
      imageCache[annotation.src] = 'loading';
      ctx.save();
      ctx.fillStyle = annotation.color;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(x, y, imgW, imgH);
      ctx.restore();
      return;
    }

    if (imageCache[annotation.src] === 'loading') return;

    const img = imageCache[annotation.src];

    ctx.save();
    ctx.drawImage(img, x, y, imgW, imgH);

    // Cadre de sélection + poignées
    if (isSel) {
      ctx.strokeStyle = '#ff9520';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x - 1, y - 1, imgW + 2, imgH + 2);
      ctx.setLineDash([]);

      // 4 poignées aux coins
      const hs = 5;
      const corners = [
        [x, y], [x + imgW, y],
        [x, y + imgH], [x + imgW, y + imgH],
      ];
      corners.forEach(([cx, cy]) => {
        ctx.fillStyle = '#fff';
        ctx.fillRect(cx - hs, cy - hs, hs * 2, hs * 2);
        ctx.strokeStyle = '#ff9520';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(cx - hs, cy - hs, hs * 2, hs * 2);
      });
    }

    // Numéro en cercle (légende)
    if (annotation.number != null) {
      ctx.beginPath();
      ctx.arc(x + imgW + 8, y + imgH / 2, 8, 0, Math.PI * 2);
      ctx.fillStyle = annotation.color;
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 9px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(annotation.number), x + imgW + 8, y + imgH / 2 + 3);
    }

    // Label en dessous
    if (annotation.label) {
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 3;
      ctx.fillText(annotation.label, pos.x, y + imgH + 12);
      ctx.shadowBlur = 0;
    }

    ctx.restore();
  }

  /**
   * Popup numéro de train
   */
  function promptTrainNumber(callback) {
    const popup = document.getElementById('train-input-popup');
    const input = document.getElementById('train-number');
    const confirmBtn = document.getElementById('train-input-confirm');
    const closeBtn = document.getElementById('train-input-close');

    popup.classList.remove('hidden');
    input.value = '';
    input.focus();

    const confirm = () => {
      const num = input.value.trim();
      if (num) {
        popup.classList.add('hidden');
        callback(num);
      }
    };

    const close = () => popup.classList.add('hidden');

    confirmBtn.onclick = confirm;
    closeBtn.onclick = close;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') confirm();
      if (e.key === 'Escape') close();
    };
    popup.querySelector('.popup-overlay').onclick = close;
  }

  function getAnnotations() { return annotations; }

  // === GESTION DES ANNOTATIONS ===

  let imageLibrary = []; // { name, dataUrl }
  let customAnnotations = []; // { name, symbol, color, placement, imageDataUrl, pinned }

  function loadImageLibrary() {
    try {
      const saved = Store.getJSON('eic_image_library', null);
      if (saved) imageLibrary = saved;
    } catch {}
  }
  function saveImageLibrary() {
    try { Store.set('eic_image_library', imageLibrary); } catch {}
  }
  function loadCustomAnnotations() {
    try {
      const saved = Store.getJSON('eic_custom_annotations', null);
      if (saved) customAnnotations = saved;
    } catch {}
  }
  function saveCustomAnnotations() {
    try { Store.set('eic_custom_annotations', customAnnotations); } catch {}
  }

  const DEFAULT_IMAGES = [
    '3058_00_nobg.png', 'agc_hdf_nobg.png', 'machinefret_nobg.png',
    'silhouette_black_only.png', 'tgv_euroduplex_nobg.png',
    'thalys_nobg.png', 'train_nobg.png', 'wagons_roco_nobg.png',
  ];

  function setupAnnotationManager() {
    loadImageLibrary();
    loadCustomAnnotations();
    renderPinnedAnnotations();
    const btn = document.getElementById('btn-manage-annotations');
    if (btn) btn.addEventListener('click', showAnnotationManager);
  }

  // === ANNOTATIONS ÉPINGLÉES DANS LA SIDEBAR ===

  function renderPinnedAnnotations() {
    const container = document.getElementById('pinned-annotations');
    if (!container) return;
    container.innerHTML = '';

    const pinned = customAnnotations.filter(c => c.pinned);
    if (pinned.length === 0) return;

    pinned.forEach((custom, _) => {
      const globalIndex = customAnnotations.indexOf(custom);
      const btn = document.createElement('div');
      btn.className = 'custom-tool-btn';
      btn.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;cursor:pointer;border-radius:3px;';
      btn.addEventListener('mouseenter', () => btn.style.background = 'var(--surface2)');
      btn.addEventListener('mouseleave', () => { if (!btn.classList.contains('active')) btn.style.background = 'none'; });

      const iconEl = document.createElement('span');
      iconEl.style.cssText = 'font-size:14px;flex-shrink:0;width:20px;text-align:center;';
      if (custom.imageDataUrl) {
        iconEl.innerHTML = '<img src="' + custom.imageDataUrl + '" style="max-height:16px;max-width:24px;vertical-align:middle;">';
      } else if (custom.imageSrc) {
        iconEl.innerHTML = '<img src="' + custom.imageSrc + '" style="max-height:16px;max-width:24px;vertical-align:middle;">';
      } else {
        iconEl.textContent = custom.symbol;
        iconEl.style.color = custom.color;
      }
      btn.appendChild(iconEl);

      const labelEl = document.createElement('span');
      labelEl.style.cssText = 'font-family:var(--mono);font-size:10px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      labelEl.textContent = custom.name;
      btn.appendChild(labelEl);

      btn.addEventListener('click', () => {
        document.querySelectorAll('.tool-btn, .custom-tool-btn').forEach(b => { b.classList.remove('active'); b.style.background = ''; });
        const isActive = btn.classList.contains('active');
        if (isActive) {
          btn.classList.remove('active');
          btn.style.background = '';
          setActiveTool(null);
        } else {
          btn.classList.add('active');
          btn.style.background = 'var(--surface2)';
          if (custom.imageDataUrl || custom.imageSrc) {
            setActiveTool('image-library');
            pendingImageSrc = custom.imageDataUrl || custom.imageSrc;
            pendingImageLabel = custom.name;
          } else if (custom.placement === 'line') {
            setActiveTool('custom-' + globalIndex);
          } else {
            setActiveTool('custom-' + globalIndex);
          }
          showStatusMessage('Cliquez sur le schéma pour placer "' + custom.name + '"');
        }
      });

      container.appendChild(btn);
    });
  }

  // === PANNEAU DE GESTION ===

  function showAnnotationManager() {
    const old = document.getElementById('annotation-manager-modal');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'annotation-manager-modal';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:400;display:flex;align-items:center;justify-content:center;';

    const panel = document.createElement('div');
    panel.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:6px;width:520px;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.4);';

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'padding:10px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;';
    const title = document.createElement('span');
    title.style.cssText = 'font-family:var(--mono);font-size:12px;font-weight:600;color:var(--text);';
    title.textContent = 'Gérer les annotations';
    header.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:0 4px;';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Onglets
    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex;border-bottom:1px solid var(--border);';
    let activeManagerTab = 'annotations';

    function createTab(id, label) {
      const tab = document.createElement('button');
      tab.style.cssText = 'flex:1;padding:8px;background:none;border:none;border-bottom:2px solid transparent;color:var(--muted);font-family:var(--mono);font-size:10px;cursor:pointer;text-transform:uppercase;letter-spacing:0.5px;';
      tab.textContent = label;
      tab.addEventListener('click', () => {
        activeManagerTab = id;
        tabBar.querySelectorAll('button').forEach(b => { b.style.borderBottomColor = 'transparent'; b.style.color = 'var(--muted)'; });
        tab.style.borderBottomColor = 'var(--accent2)';
        tab.style.color = 'var(--text)';
        renderContent();
      });
      if (id === activeManagerTab) {
        tab.style.borderBottomColor = 'var(--accent2)';
        tab.style.color = 'var(--text)';
      }
      return tab;
    }
    tabBar.appendChild(createTab('annotations', 'Annotations'));
    tabBar.appendChild(createTab('images', 'Bibliothèque d\'images'));
    panel.appendChild(tabBar);

    // Contenu
    const contentDiv = document.createElement('div');
    contentDiv.style.cssText = 'overflow-y:auto;flex:1;';
    panel.appendChild(contentDiv);

    function renderContent() {
      contentDiv.innerHTML = '';
      if (activeManagerTab === 'annotations') renderAnnotationsTab();
      else renderImagesTab();
    }

    // === ONGLET ANNOTATIONS ===
    function renderAnnotationsTab() {
      // Bouton créer
      const addRow = document.createElement('div');
      addRow.style.cssText = 'padding:8px 14px;';
      const addBtn = document.createElement('button');
      addBtn.style.cssText = 'width:100%;padding:6px;background:var(--surface2);border:1px dashed var(--border);border-radius:3px;color:var(--accent2);font-family:var(--mono);font-size:10px;cursor:pointer;';
      addBtn.textContent = '+ Créer une annotation';
      addBtn.addEventListener('click', () => showCreateAnnotationForm(contentDiv, renderAnnotationsTab));
      addRow.appendChild(addBtn);
      contentDiv.appendChild(addRow);

      if (customAnnotations.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:20px 14px;text-align:center;font-family:var(--mono);font-size:11px;color:var(--muted);';
        empty.textContent = 'Aucune annotation personnalisée';
        contentDiv.appendChild(empty);
        return;
      }

      customAnnotations.forEach((custom, index) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 14px;border-bottom:1px solid var(--border);';
        row.addEventListener('mouseenter', () => row.style.background = 'var(--surface2)');
        row.addEventListener('mouseleave', () => row.style.background = 'none');

        // Icône
        const icon = document.createElement('span');
        icon.style.cssText = 'font-size:16px;width:24px;text-align:center;flex-shrink:0;';
        if (custom.imageDataUrl) {
          icon.innerHTML = '<img src="' + custom.imageDataUrl + '" style="max-height:20px;max-width:28px;">';
        } else if (custom.imageSrc) {
          icon.innerHTML = '<img src="' + custom.imageSrc + '" style="max-height:20px;max-width:28px;">';
        } else {
          icon.textContent = custom.symbol;
          icon.style.color = custom.color;
        }
        row.appendChild(icon);

        // Nom
        const name = document.createElement('span');
        name.style.cssText = 'font-family:var(--mono);font-size:11px;color:var(--text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        name.textContent = custom.name;
        row.appendChild(name);

        // Type
        const typeBadge = document.createElement('span');
        typeBadge.style.cssText = 'font-family:var(--mono);font-size:8px;padding:1px 5px;border:1px solid var(--border);border-radius:2px;color:var(--muted);flex-shrink:0;';
        typeBadge.textContent = custom.placement === 'image' ? 'image' : custom.placement === 'line' ? 'ligne' : 'point';
        row.appendChild(typeBadge);

        // Bouton épingler
        const pinBtn = document.createElement('button');
        pinBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:12px;padding:2px 4px;flex-shrink:0;';
        pinBtn.textContent = custom.pinned ? '📌' : '📍';
        pinBtn.title = custom.pinned ? 'Désépingler de la sidebar' : 'Épingler dans la sidebar';
        pinBtn.style.opacity = custom.pinned ? '1' : '0.4';
        pinBtn.addEventListener('click', () => {
          custom.pinned = !custom.pinned;
          saveCustomAnnotations();
          renderPinnedAnnotations();
          renderAnnotationsTab();
        });
        row.appendChild(pinBtn);

        // Bouton supprimer
        const delBtn = document.createElement('button');
        delBtn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:11px;color:var(--muted);padding:2px 4px;flex-shrink:0;';
        delBtn.textContent = '✕';
        delBtn.title = 'Supprimer';
        delBtn.addEventListener('click', () => {
          if (confirm('Supprimer "' + custom.name + '" ?')) {
            customAnnotations.splice(index, 1);
            saveCustomAnnotations();
            renderPinnedAnnotations();
            renderAnnotationsTab();
          }
        });
        row.appendChild(delBtn);

        contentDiv.appendChild(row);
      });
    }

    // === FORMULAIRE CRÉER ANNOTATION ===
    function showCreateAnnotationForm(container, onDone) {
      container.innerHTML = '';

      const form = document.createElement('div');
      form.style.cssText = 'padding:10px 14px;';

      // Nom
      const nameLabel = document.createElement('div');
      nameLabel.style.cssText = 'font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;margin-bottom:3px;';
      nameLabel.textContent = 'Nom';
      form.appendChild(nameLabel);
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.placeholder = 'Ex: Machine de secours';
      nameInput.style.cssText = 'width:100%;padding:5px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:3px;color:var(--text);font-family:var(--mono);font-size:11px;outline:none;margin-bottom:10px;';
      form.appendChild(nameInput);

      // Source : symbole ou image
      const srcLabel = document.createElement('div');
      srcLabel.style.cssText = 'font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;margin-bottom:3px;';
      srcLabel.textContent = 'Type';
      form.appendChild(srcLabel);

      const srcRow = document.createElement('div');
      srcRow.style.cssText = 'display:flex;gap:6px;margin-bottom:10px;';
      let srcType = 'symbol';

      const symBtn = document.createElement('button');
      symBtn.style.cssText = 'flex:1;padding:5px;background:var(--accent2);border:none;border-radius:3px;color:var(--bg);font-family:var(--mono);font-size:10px;cursor:pointer;';
      symBtn.textContent = 'Symbole';
      const imgBtn = document.createElement('button');
      imgBtn.style.cssText = 'flex:1;padding:5px;background:var(--surface2);border:1px solid var(--border);border-radius:3px;color:var(--text);font-family:var(--mono);font-size:10px;cursor:pointer;';
      imgBtn.textContent = 'Image';

      function setSrcType(type) {
        srcType = type;
        if (type === 'symbol') {
          symBtn.style.background = 'var(--accent2)'; symBtn.style.color = 'var(--bg)'; symBtn.style.border = 'none';
          imgBtn.style.background = 'var(--surface2)'; imgBtn.style.color = 'var(--text)'; imgBtn.style.border = '1px solid var(--border)';
          symbolSection.style.display = '';
          imageSection.style.display = 'none';
        } else {
          imgBtn.style.background = 'var(--accent2)'; imgBtn.style.color = 'var(--bg)'; imgBtn.style.border = 'none';
          symBtn.style.background = 'var(--surface2)'; symBtn.style.color = 'var(--text)'; symBtn.style.border = '1px solid var(--border)';
          symbolSection.style.display = 'none';
          imageSection.style.display = '';
        }
      }
      symBtn.addEventListener('click', () => setSrcType('symbol'));
      imgBtn.addEventListener('click', () => setSrcType('image'));
      srcRow.appendChild(symBtn);
      srcRow.appendChild(imgBtn);
      form.appendChild(srcRow);

      // Section symbole
      const symbolSection = document.createElement('div');
      const symbols = ['●', '✕', '⏸', '◆', '▲', '⚠', '■', '★', '◈', '⬥', '━', '⊘'];
      let selectedSymbol = '●';
      let selectedColor = '#ff4040';

      const symGrid = document.createElement('div');
      symGrid.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;';
      symbols.forEach(s => {
        const b = document.createElement('button');
        b.style.cssText = 'width:28px;height:28px;background:var(--surface2);border:1px solid var(--border);border-radius:3px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;';
        b.textContent = s;
        if (s === selectedSymbol) b.style.borderColor = 'var(--accent2)';
        b.addEventListener('click', () => {
          selectedSymbol = s;
          symGrid.querySelectorAll('button').forEach(bb => bb.style.borderColor = 'var(--border)');
          b.style.borderColor = 'var(--accent2)';
        });
        symGrid.appendChild(b);
      });
      symbolSection.appendChild(symGrid);

      // Couleurs
      const colors = ['#ff4040', '#ff9520', '#00d4a0', '#3080ff', '#9060ff', '#ff69b4', '#ffcc00', '#ffffff'];
      const colorGrid = document.createElement('div');
      colorGrid.style.cssText = 'display:flex;gap:4px;margin-bottom:8px;';
      colors.forEach(c => {
        const b = document.createElement('button');
        b.style.cssText = 'width:22px;height:22px;border-radius:50%;border:2px solid var(--border);cursor:pointer;background:' + c + ';';
        if (c === selectedColor) b.style.borderColor = 'var(--text)';
        b.addEventListener('click', () => {
          selectedColor = c;
          colorGrid.querySelectorAll('button').forEach(bb => bb.style.borderColor = 'var(--border)');
          b.style.borderColor = 'var(--text)';
        });
        colorGrid.appendChild(b);
      });
      symbolSection.appendChild(colorGrid);

      // Placement
      const placementLabel = document.createElement('div');
      placementLabel.style.cssText = 'font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;margin-bottom:3px;';
      placementLabel.textContent = 'Placement';
      symbolSection.appendChild(placementLabel);
      let selectedPlacement = 'point';
      const placementRow = document.createElement('div');
      placementRow.style.cssText = 'display:flex;gap:6px;margin-bottom:10px;';
      [['point', 'Point'], ['line', 'Ligne (2 clics)']].forEach(([val, lab]) => {
        const b = document.createElement('button');
        b.style.cssText = 'flex:1;padding:4px;background:' + (val === 'point' ? 'var(--accent2)' : 'var(--surface2)') + ';border:1px solid var(--border);border-radius:3px;color:' + (val === 'point' ? 'var(--bg)' : 'var(--text)') + ';font-family:var(--mono);font-size:10px;cursor:pointer;';
        b.textContent = lab;
        b.addEventListener('click', () => {
          selectedPlacement = val;
          placementRow.querySelectorAll('button').forEach(bb => { bb.style.background = 'var(--surface2)'; bb.style.color = 'var(--text)'; });
          b.style.background = 'var(--accent2)'; b.style.color = 'var(--bg)';
        });
        placementRow.appendChild(b);
      });
      symbolSection.appendChild(placementRow);
      form.appendChild(symbolSection);

      // Section image
      const imageSection = document.createElement('div');
      imageSection.style.display = 'none';

      // Sélection depuis la bibliothèque
      const imgLabel = document.createElement('div');
      imgLabel.style.cssText = 'font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;margin-bottom:5px;';
      imgLabel.textContent = 'Choisir une image';
      imageSection.appendChild(imgLabel);

      let selectedImgSrc = null;
      const imgGrid = document.createElement('div');
      imgGrid.style.cssText = 'display:grid;grid-template-columns:repeat(5,1fr);gap:4px;margin-bottom:8px;max-height:120px;overflow-y:auto;';

      function renderImgOptions() {
        imgGrid.innerHTML = '';
        const allImgs = [
          ...DEFAULT_IMAGES.map(f => ({ src: 'img/' + f, name: f.replace(/_nobg|\.png/g, '').replace(/_/g, ' ') })),
          ...imageLibrary.map(i => ({ src: i.dataUrl, name: i.name })),
        ];
        allImgs.forEach(img => {
          const card = document.createElement('div');
          card.style.cssText = 'background:var(--surface2);border:1px solid var(--border);border-radius:3px;padding:3px;cursor:pointer;display:flex;align-items:center;justify-content:center;height:40px;';
          const imgEl = document.createElement('img');
          imgEl.src = img.src;
          imgEl.style.cssText = 'max-height:34px;max-width:100%;object-fit:contain;';
          imgEl.title = img.name;
          card.appendChild(imgEl);
          card.addEventListener('click', () => {
            selectedImgSrc = img.src;
            imgGrid.querySelectorAll('div').forEach(d => d.style.borderColor = 'var(--border)');
            card.style.borderColor = 'var(--accent2)';
            if (!nameInput.value) nameInput.value = img.name;
          });
          imgGrid.appendChild(card);
        });
      }
      renderImgOptions();
      imageSection.appendChild(imgGrid);

      // Ou uploader
      const orLabel = document.createElement('div');
      orLabel.style.cssText = 'font-family:var(--mono);font-size:9px;color:var(--muted);text-align:center;margin:4px 0;';
      orLabel.textContent = 'ou uploader une nouvelle image';
      imageSection.appendChild(orLabel);
      const uploadRow = document.createElement('div');
      uploadRow.style.cssText = 'margin-bottom:10px;';
      const fileIn = document.createElement('input');
      fileIn.type = 'file'; fileIn.accept = 'image/*';
      fileIn.style.cssText = 'font-family:var(--mono);font-size:10px;color:var(--text);';
      fileIn.addEventListener('change', () => {
        const file = fileIn.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          selectedImgSrc = ev.target.result;
          if (!nameInput.value) nameInput.value = file.name.replace(/\.[^.]+$/, '');
        };
        reader.readAsDataURL(file);
      });
      uploadRow.appendChild(fileIn);
      imageSection.appendChild(uploadRow);
      form.appendChild(imageSection);

      // Boutons
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:6px;padding-top:6px;';
      const cancelBtn = document.createElement('button');
      cancelBtn.style.cssText = 'flex:1;padding:6px;background:var(--surface2);border:1px solid var(--border);border-radius:3px;color:var(--text);font-family:var(--mono);font-size:10px;cursor:pointer;';
      cancelBtn.textContent = 'Annuler';
      cancelBtn.addEventListener('click', onDone);
      btnRow.appendChild(cancelBtn);

      const saveBtn = document.createElement('button');
      saveBtn.style.cssText = 'flex:1;padding:6px;background:var(--accent2);border:none;border-radius:3px;color:var(--bg);font-family:var(--mono);font-size:10px;font-weight:600;cursor:pointer;';
      saveBtn.textContent = 'Créer';
      saveBtn.addEventListener('click', () => {
        const name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }

        const def = { name, pinned: false };
        if (srcType === 'image' && selectedImgSrc) {
          def.placement = 'image';
          // Si c'est un dataUrl, stocker inline. Sinon c'est un chemin local.
          if (selectedImgSrc.startsWith('data:')) {
            def.imageDataUrl = selectedImgSrc;
          } else {
            def.imageSrc = selectedImgSrc;
          }
          def.symbol = '🖼'; def.color = '#c8daf5';
        } else {
          def.symbol = selectedSymbol;
          def.color = selectedColor;
          def.placement = selectedPlacement;
        }

        customAnnotations.push(def);
        saveCustomAnnotations();
        renderPinnedAnnotations();
        onDone();
      });
      btnRow.appendChild(saveBtn);
      form.appendChild(btnRow);

      container.appendChild(form);
      nameInput.focus();
    }

    // === ONGLET IMAGES ===
    function renderImagesTab() {
      // Upload
      const uploadRow = document.createElement('div');
      uploadRow.style.cssText = 'padding:8px 14px;';
      const uploadBtn = document.createElement('button');
      uploadBtn.style.cssText = 'width:100%;padding:6px;background:var(--surface2);border:1px dashed var(--border);border-radius:3px;color:var(--accent2);font-family:var(--mono);font-size:10px;cursor:pointer;';
      uploadBtn.textContent = '+ Ajouter des images';
      const fileInput = document.createElement('input');
      fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.multiple = true; fileInput.style.display = 'none';
      uploadBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        Array.from(fileInput.files).forEach(file => {
          const reader = new FileReader();
          reader.onload = (ev) => {
            imageLibrary.push({ name: file.name.replace(/\.[^.]+$/, ''), dataUrl: ev.target.result });
            saveImageLibrary();
            renderImagesTab();
          };
          reader.readAsDataURL(file);
        });
      });
      uploadRow.appendChild(uploadBtn);
      uploadRow.appendChild(fileInput);
      contentDiv.appendChild(uploadRow);

      // Grille
      const gridDiv = document.createElement('div');
      gridDiv.style.cssText = 'padding:6px 14px;display:grid;grid-template-columns:repeat(4,1fr);gap:8px;';
      contentDiv.appendChild(gridDiv);

      // Images par défaut
      const defLabel = document.createElement('div');
      defLabel.style.cssText = 'grid-column:1/-1;font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;padding-top:4px;';
      defLabel.textContent = 'Images par défaut';
      gridDiv.appendChild(defLabel);
      DEFAULT_IMAGES.forEach(f => {
        gridDiv.appendChild(createImgCard('img/' + f, f.replace(/_nobg|\.png/g, '').replace(/_/g, ' '), true));
      });

      // Images uploadées
      if (imageLibrary.length > 0) {
        const uplLabel = document.createElement('div');
        uplLabel.style.cssText = 'grid-column:1/-1;font-family:var(--mono);font-size:9px;color:var(--muted);text-transform:uppercase;padding-top:8px;';
        uplLabel.textContent = 'Images uploadées';
        gridDiv.appendChild(uplLabel);
        imageLibrary.forEach((img, i) => {
          gridDiv.appendChild(createImgCard(img.dataUrl, img.name, false, i));
        });
      }
    }

    function createImgCard(src, name, isDefault, libIndex) {
      const card = document.createElement('div');
      card.style.cssText = 'background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:6px;display:flex;flex-direction:column;align-items:center;gap:4px;position:relative;';

      const img = document.createElement('img');
      img.src = src;
      img.style.cssText = 'max-height:45px;max-width:100%;object-fit:contain;';
      card.appendChild(img);

      const label = document.createElement('span');
      label.style.cssText = 'font-family:var(--mono);font-size:7px;color:var(--muted);text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%;';
      label.textContent = name;
      card.appendChild(label);

      if (!isDefault) {
        const del = document.createElement('button');
        del.style.cssText = 'position:absolute;top:2px;right:2px;background:rgba(0,0,0,0.6);border:none;color:#ff4040;font-size:10px;cursor:pointer;border-radius:50%;width:16px;height:16px;display:flex;align-items:center;justify-content:center;';
        del.textContent = '✕';
        del.addEventListener('click', () => {
          imageLibrary.splice(libIndex, 1);
          saveImageLibrary();
          renderImagesTab();
        });
        card.appendChild(del);
      }

      return card;
    }

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    renderContent();
  }

  // Image en attente de placement
  let pendingImageSrc = null;
  let pendingImageLabel = null;

  // === LÉGENDE ===
  let legendVisible = false;

  function setupLegend() {
    const btn = document.getElementById('btn-legend');
    const panel = document.getElementById('legend-panel');
    const closeBtn = document.getElementById('legend-close');
    if (!btn || !panel) return;

    btn.addEventListener('click', () => {
      legendVisible = !legendVisible;
      if (legendVisible) {
        panel.classList.remove('hidden');
        refreshLegend();
      } else {
        panel.classList.add('hidden');
      }
    });

    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        legendVisible = false;
        panel.classList.add('hidden');
      });
    }

    // Rendre draggable
    if (typeof interact !== 'undefined') {
      interact(panel).draggable({
        allowFrom: '#legend-header',
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
  }

  function refreshLegend() {
    const content = document.getElementById('legend-content');
    if (!content || !legendVisible) return;

    // Filtrer les annotations numérotées (trains, markers, lignes)
    const numbered = annotations.filter(a => a.number != null);

    if (numbered.length === 0) {
      content.innerHTML = '<div class="legend-empty">Aucune annotation</div>';
      return;
    }

    // Grouper par tool
    const groups = {};
    numbered.forEach(a => {
      const key = a.tool || a.type;
      if (!groups[key]) groups[key] = [];
      groups[key].push(a);
    });

    content.innerHTML = '';

    for (const [tool, items] of Object.entries(groups)) {
      // Titre du groupe
      const groupTitle = document.createElement('div');
      groupTitle.style.cssText = 'padding:4px 12px 2px; font-family:var(--mono); font-size:9px; letter-spacing:1px; text-transform:uppercase; color:var(--muted);';
      const firstItem = items[0];
      groupTitle.textContent = firstItem.label || TRAIN_SYMBOLS[tool]?.label || MARKER_SYMBOLS[tool]?.label || tool;
      content.appendChild(groupTitle);

      // Items
      items.sort((a, b) => a.number - b.number);
      items.forEach(a => {
        const row = document.createElement('div');
        row.className = 'legend-item';

        // Icône
        const icon = document.createElement('span');
        icon.className = 'legend-item-icon';
        icon.style.color = a.color;
        if (a.type === 'image' && a.src) {
          const img = document.createElement('img');
          img.src = a.src;
          img.style.cssText = 'height:14px;width:auto;vertical-align:middle;';
          icon.textContent = '';
          icon.appendChild(img);
        } else {
          icon.textContent = a.symbol || getAnnotationIcon(a);
        }

        // Pastille numéro
        const numBadge = document.createElement('span');
        numBadge.className = 'legend-item-number';
        numBadge.style.background = a.color;
        numBadge.textContent = String(a.number);

        // Champ éditable
        const textWrap = document.createElement('span');
        textWrap.className = 'legend-item-text';
        const input = document.createElement('input');
        input.type = 'text';
        input.value = a.legendText || a.trainNumber || a.message || '';
        input.placeholder = 'Description...';
        input.addEventListener('change', () => {
          a.legendText = input.value;
          saveToLocalStorage();
        });
        input.addEventListener('blur', () => {
          a.legendText = input.value;
          saveToLocalStorage();
        });
        textWrap.appendChild(input);

        row.appendChild(icon);
        row.appendChild(numBadge);
        row.appendChild(textWrap);
        content.appendChild(row);
      });
    }
  }

  // Rafraîchir la légende quand les annotations changent
  const originalRedraw = redraw;
  redraw = function() {
    originalRedraw();
    if (legendVisible) refreshLegend();
  };

  return {
    init,
    setActiveTool,
    highlightElement,
    addTrainAnnotation,
    addTextAnnotation,
    remove,
    clear,
    redraw,
    getAnnotations,
    undo,
    redo,
    setupLegend,
    refreshLegend,
    setupAnnotationManager,
    getActiveTool,
  };
})();
