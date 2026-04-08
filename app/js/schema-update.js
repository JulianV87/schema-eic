/**
 * SchemaUpdate — Mise à jour du schéma depuis le navigateur
 *
 * Workflow :
 * 1. L'utilisateur upload un PDF
 * 2. pdf.js rend la page 1 en haute résolution
 * 3. Comparaison bloc par bloc avec l'ancien schéma
 * 4. Seules les tuiles modifiées sont regénérées
 * 5. Upload vers Supabase Storage
 * 6. Le viewer recharge depuis Supabase
 */
const SchemaUpdate = (() => {

  const SUPABASE_URL = 'https://fbcwsgqrwolxnqpasbgl.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZiY3dzZ3Fyd29seG5xcGFzYmdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NDM5NDgsImV4cCI6MjA4OTUxOTk0OH0.yxadPWsLZwYbpet9wlYfTxW9Halx-XMV56PvorCKwIU';
  const STORAGE_BUCKET = 'tiles';

  const TILE_SIZE = 256;
  const OVERLAP = 1;
  const DPI = 300;
  const COMPARE_BLOCK = 512;
  const DIFF_THRESHOLD = 10;
  const BLOCK_CHANGE_PCT = 0.5;

  let pdfjsLib = null;
  let _log = null;
  let _floatingEl = null;

  /**
   * Indicateur flottant en haut à droite (visible même hors paramètres)
   */
  function showFloating(text, pct) {
    if (!_floatingEl) {
      _floatingEl = document.createElement('div');
      _floatingEl.id = 'schema-update-floating';
      _floatingEl.style.cssText = 'position:fixed;top:52px;right:12px;z-index:9999;' +
        'background:#0c1220;border:1px solid #1e304a;border-radius:8px;padding:8px 14px;' +
        'font-family:"JetBrains Mono",monospace;font-size:11px;color:#c8daf5;' +
        'box-shadow:0 4px 16px rgba(0,0,0,0.5);min-width:220px;max-width:340px;';
      _floatingEl.innerHTML =
        '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">' +
          '<span id="suf-dot" style="width:8px;height:8px;border-radius:50%;background:#ff9520;display:inline-block;animation:suf-pulse 1.5s infinite;"></span>' +
          '<span id="suf-title" style="font-weight:600;color:#ff9520;">Mise a jour schema</span>' +
        '</div>' +
        '<div id="suf-text" style="color:#4a6a9a;line-height:1.4;"></div>' +
        '<div style="background:#111a2e;border-radius:3px;overflow:hidden;height:4px;margin-top:6px;">' +
          '<div id="suf-bar" style="height:100%;background:#ff9520;width:0%;transition:width 0.3s;"></div>' +
        '</div>';
      // Animation pulse
      const style = document.createElement('style');
      style.textContent = '@keyframes suf-pulse{0%,100%{opacity:1}50%{opacity:0.3}}';
      document.head.appendChild(style);
      document.body.appendChild(_floatingEl);
    }
    const textEl = document.getElementById('suf-text');
    const barEl = document.getElementById('suf-bar');
    if (textEl) textEl.textContent = text;
    if (barEl && typeof pct === 'number') barEl.style.width = Math.round(pct * 100) + '%';
  }

  function updateFloatingDone() {
    if (!_floatingEl) return;
    const dot = document.getElementById('suf-dot');
    const title = document.getElementById('suf-title');
    const bar = document.getElementById('suf-bar');
    if (dot) { dot.style.background = '#00d4a0'; dot.style.animation = 'none'; }
    if (title) { title.textContent = 'Schema a jour'; title.style.color = '#00d4a0'; }
    if (bar) { bar.style.width = '100%'; bar.style.background = '#00d4a0'; }
    // Masquer après 10s
    setTimeout(() => { if (_floatingEl) { _floatingEl.remove(); _floatingEl = null; } }, 10000);
  }

  function hideFloating() {
    if (_floatingEl) { _floatingEl.remove(); _floatingEl = null; }
  }

  function headers(contentType) {
    const h = {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
    };
    if (contentType) h['Content-Type'] = contentType;
    return h;
  }

  function log(msg) {
    console.log('[SchemaUpdate]', msg);
    if (_log) {
      _log.textContent += msg + '\n';
      _log.scrollTop = _log.scrollHeight;
    }
  }

  /**
   * Charger pdf.js depuis CDN si pas déjà chargé
   */
  async function loadPdfJs() {
    if (pdfjsLib) return;
    if (window.pdfjsLib) {
      pdfjsLib = window.pdfjsLib;
      return;
    }

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      script.onload = () => {
        pdfjsLib = window.pdfjsLib;
        pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        resolve();
      };
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  /**
   * Rendre le PDF page 1 dans un canvas
   */
  // renderPdfChunked remplacé par renderPdfAtDpi dans processUpdate

  /**
   * Extraire une région depuis les bandes en un canvas
   */
  function extractRegion(strips, x, y, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    for (const strip of strips) {
      const ox1 = Math.max(strip.x, x);
      const ox2 = Math.min(strip.x + strip.width, x + w);
      if (ox2 <= ox1) continue;

      const srcX = ox1 - strip.x;
      const dstX = ox1 - x;
      const drawW = ox2 - ox1;
      const srcY = Math.max(0, y);
      const dstY = 0;
      const drawH = Math.min(h, strip.canvas.height - srcY);

      ctx.drawImage(strip.canvas, srcX, srcY, drawW, drawH, dstX, dstY, drawW, drawH);
    }
    return canvas;
  }

  /**
   * Créer un preview (petit canvas) depuis les bandes
   */
  function createPreview(strips, fullW, fullH, maxWidth) {
    const pw = Math.min(maxWidth, fullW);
    const ph = Math.round(pw * fullH / fullW);
    const canvas = document.createElement('canvas');
    canvas.width = pw;
    canvas.height = ph;
    const ctx = canvas.getContext('2d');

    for (const strip of strips) {
      const srcX = 0;
      const srcY = 0;
      const dstX = Math.round(strip.x * pw / fullW);
      const dstW = Math.round(strip.width * pw / fullW);
      ctx.drawImage(strip.canvas, srcX, srcY, strip.width, fullH, dstX, 0, dstW, ph);
    }
    return canvas;
  }

  /**
   * Charger l'ancien schéma preview en canvas
   * Retourne { canvas, fromSupabase } ou null
   */
  async function loadOldPreview() {
    // Essayer Supabase Storage d'abord, puis local
    const sources = [
      { url: SUPABASE_URL + '/storage/v1/object/public/' + STORAGE_BUCKET + '/schema_preview.png', supabase: true },
      { url: '/tiles/schema_preview.png', supabase: false },
    ];

    for (const src of sources) {
      try {
        const resp = await fetch(src.url, { method: 'HEAD' });
        if (!resp.ok) continue;

        const canvas = await new Promise((resolve, reject) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            resolve(c);
          };
          img.onerror = reject;
          img.src = src.url;
        });
        return { canvas, fromSupabase: src.supabase };
      } catch { /* try next */ }
    }
    return null;
  }

  /**
   * Comparer deux canvas bloc par bloc, retourne les blocs modifiés
   */
  function compareBlocks(oldCanvas, newCanvas) {
    const W = newCanvas.width;
    const H = newCanvas.height;
    const cols = Math.ceil(W / COMPARE_BLOCK);
    const rows = Math.ceil(H / COMPARE_BLOCK);
    const changed = [];

    const oldCtx = oldCanvas.getContext('2d');
    const newCtx = newCanvas.getContext('2d');

    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        const left = bx * COMPARE_BLOCK;
        const top = by * COMPARE_BLOCK;
        const w = Math.min(COMPARE_BLOCK, W - left);
        const h = Math.min(COMPARE_BLOCK, H - top);

        const oldData = oldCtx.getImageData(left, top, w, h).data;
        const newData = newCtx.getImageData(left, top, w, h).data;

        const totalPixels = w * h;
        let diffPixels = 0;

        for (let i = 0; i < oldData.length; i += 4) {
          const dr = Math.abs(oldData[i] - newData[i]);
          const dg = Math.abs(oldData[i + 1] - newData[i + 1]);
          const db = Math.abs(oldData[i + 2] - newData[i + 2]);
          if (dr > DIFF_THRESHOLD || dg > DIFF_THRESHOLD || db > DIFF_THRESHOLD) {
            diffPixels++;
          }
        }

        const pct = (diffPixels / totalPixels) * 100;
        if (pct >= BLOCK_CHANGE_PCT) {
          changed.push({ bx, by, left, top, width: w, height: h, pct: pct.toFixed(1) });
        }
      }
    }

    return changed;
  }

  /**
   * Vérifie si une tuile intersecte un des blocs modifiés
   */
  function tileIntersectsChanges(tileSourceX, tileSourceY, tileSourceW, tileSourceH, changedBlocks) {
    return changedBlocks.some(b =>
      tileSourceX < b.left + b.width &&
      tileSourceX + tileSourceW > b.left &&
      tileSourceY < b.top + b.height &&
      tileSourceY + tileSourceH > b.top
    );
  }

  /**
   * Générer une tuile JPEG blob depuis les bandes source (haute résolution)
   */
  function extractTileBlobFromStrips(strips, fullW, fullH, levelWidth, levelHeight, col, row, tileCols, tileRows) {
    const x = col * TILE_SIZE - (col > 0 ? OVERLAP : 0);
    const y = row * TILE_SIZE - (row > 0 ? OVERLAP : 0);
    const w = Math.min(
      TILE_SIZE + (col > 0 ? OVERLAP : 0) + (col < tileCols - 1 ? OVERLAP : 0),
      levelWidth - col * TILE_SIZE + (col > 0 ? OVERLAP : 0)
    );
    const h = Math.min(
      TILE_SIZE + (row > 0 ? OVERLAP : 0) + (row < tileRows - 1 ? OVERLAP : 0),
      levelHeight - row * TILE_SIZE + (row > 0 ? OVERLAP : 0)
    );

    if (w <= 0 || h <= 0) return null;

    const safeX = Math.max(0, x);
    const safeY = Math.max(0, y);
    const safeW = Math.min(w, levelWidth - safeX);
    const safeH = Math.min(h, levelHeight - safeY);

    if (safeW <= 0 || safeH <= 0) return null;

    // Mapper les coordonnées de la tuile vers l'image source haute résolution
    const scaleX = fullW / levelWidth;
    const scaleY = fullH / levelHeight;
    const srcX = Math.floor(safeX * scaleX);
    const srcY = Math.floor(safeY * scaleY);
    const srcW = Math.ceil(safeW * scaleX);
    const srcH = Math.ceil(safeH * scaleY);

    // Extraire la région source depuis les bandes
    const srcCanvas = extractRegion(strips, srcX, srcY, srcW, srcH);

    // Redimensionner à la taille de la tuile
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = safeW;
    tileCanvas.height = safeH;
    tileCanvas.getContext('2d').drawImage(srcCanvas, 0, 0, srcW, srcH, 0, 0, safeW, safeH);

    return new Promise(resolve => {
      tileCanvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.92);
    });
  }

  /**
   * Extraire une tuile directement depuis un canvas déjà redimensionné (niveaux bas)
   */
  function extractTileDirect(sourceCanvas, levelWidth, levelHeight, col, row, tileCols, tileRows) {
    const x = col * TILE_SIZE - (col > 0 ? OVERLAP : 0);
    const y = row * TILE_SIZE - (row > 0 ? OVERLAP : 0);
    const w = Math.min(
      TILE_SIZE + (col > 0 ? OVERLAP : 0) + (col < tileCols - 1 ? OVERLAP : 0),
      levelWidth - col * TILE_SIZE + (col > 0 ? OVERLAP : 0)
    );
    const h = Math.min(
      TILE_SIZE + (row > 0 ? OVERLAP : 0) + (row < tileRows - 1 ? OVERLAP : 0),
      levelHeight - row * TILE_SIZE + (row > 0 ? OVERLAP : 0)
    );
    if (w <= 0 || h <= 0) return null;

    const safeX = Math.max(0, x);
    const safeY = Math.max(0, y);
    const safeW = Math.min(w, levelWidth - safeX);
    const safeH = Math.min(h, levelHeight - safeY);
    if (safeW <= 0 || safeH <= 0) return null;

    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = safeW;
    tileCanvas.height = safeH;
    tileCanvas.getContext('2d').drawImage(sourceCanvas, safeX, safeY, safeW, safeH, 0, 0, safeW, safeH);

    return new Promise(resolve => {
      tileCanvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.92);
    });
  }

  /**
   * Upload un fichier vers Supabase Storage avec retries
   */
  async function uploadToStorage(path, blob, contentType, retries) {
    const maxRetries = retries || 3;
    const url = SUPABASE_URL + '/storage/v1/object/' + STORAGE_BUCKET + '/' + path;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // Attendre avant de réessayer (backoff exponentiel)
          await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
        }

        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            ...headers(),
            'Content-Type': contentType || 'application/octet-stream',
            'x-upsert': 'true',
          },
          body: blob,
        });

        if (resp.ok) return;

        // Bucket inexistant → le créer et réessayer
        if ((resp.status === 404 || resp.status === 400) && attempt === 0) {
          await ensureBucket();
          continue;
        }

        // Rate limit → réessayer
        if (resp.status === 429) continue;

        // Autre erreur au dernier essai
        if (attempt === maxRetries - 1) {
          throw new Error('Upload echoue: ' + path + ' (' + resp.status + ')');
        }
      } catch (e) {
        if (attempt === maxRetries - 1) throw e;
        // Erreur réseau → réessayer
      }
    }
  }

  /** Petite pause pour éviter le rate limiting */
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /** Vérifier qu'un canvas n'est pas vide (détecte les erreurs silencieuses) */
  function validateCanvas(ctx, w, h) {
    try {
      const sample = ctx.getImageData(0, 0, Math.min(10, w), Math.min(10, h));
      let nonWhite = 0;
      for (let i = 0; i < sample.data.length; i += 4) {
        if (sample.data[i] < 250 || sample.data[i + 1] < 250 || sample.data[i + 2] < 250) {
          nonWhite++;
        }
      }
      if (nonWhite === 0) {
        log('ATTENTION: le canvas semble vide apres le rendu PDF');
      }
    } catch (e) {
      log('Validation canvas: ' + e.message);
    }
  }

  /**
   * Créer le bucket Supabase Storage si nécessaire
   */
  async function ensureBucket() {
    try {
      await fetch(SUPABASE_URL + '/storage/v1/bucket', {
        method: 'POST',
        headers: headers('application/json'),
        body: JSON.stringify({
          id: STORAGE_BUCKET,
          name: STORAGE_BUCKET,
          public: true,
        }),
      });
    } catch { /* bucket existe peut-être déjà */ }
  }

  /**
   * Redimensionner un canvas
   */
  function resizeCanvas(source, targetWidth, targetHeight) {
    const c = document.createElement('canvas');
    c.width = targetWidth;
    c.height = targetHeight;
    c.getContext('2d').drawImage(source, 0, 0, targetWidth, targetHeight);
    return c;
  }

  /**
   * Générer et uploader les tuiles pour un DPI donné
   */
  async function generateAndUploadTiles(file, dpi, progressCb) {
    const progress = progressCb || (() => {});

    progress('pdf', 'Rendu PDF a ' + dpi + ' DPI...');
    const rendered = await renderPdfAtDpi(file, dpi);
    const { strips, width: W, height: H } = rendered;
    const maxLevel = Math.ceil(Math.log2(Math.max(W, H)));

    // Compter les tuiles
    let totalTiles = 0;
    for (let level = maxLevel; level >= 0; level--) {
      const ls = Math.pow(2, level - maxLevel);
      totalTiles += Math.ceil(Math.max(1, Math.ceil(W * ls)) / TILE_SIZE) * Math.ceil(Math.max(1, Math.ceil(H * ls)) / TILE_SIZE);
    }

    // ============================================================
    // PHASE 1 : Générer TOUS les blobs de tuiles en mémoire
    // (aucun appel réseau ici — le canvas reste vivant)
    // ============================================================
    progress('tiles', dpi + ' DPI — Generation des tuiles...', 0);
    log('Generation de ~' + totalTiles + ' tuiles en memoire...');

    const tileBlobs = []; // { path, blob }
    let generated = 0;

    for (let level = maxLevel; level >= 0; level--) {
      const levelScale = Math.pow(2, level - maxLevel);
      const levelWidth = Math.max(1, Math.ceil(W * levelScale));
      const levelHeight = Math.max(1, Math.ceil(H * levelScale));
      const tileCols = Math.ceil(levelWidth / TILE_SIZE);
      const tileRows = Math.ceil(levelHeight / TILE_SIZE);

      const useDirectCanvas = (levelWidth * levelHeight) < 20_000_000;
      let levelCanvas = useDirectCanvas ? createPreview(strips, W, H, levelWidth) : null;

      for (let col = 0; col < tileCols; col++) {
        for (let row = 0; row < tileRows; row++) {
          let blob;
          if (levelCanvas) {
            blob = await extractTileDirect(levelCanvas, levelWidth, levelHeight, col, row, tileCols, tileRows);
          } else {
            blob = await extractTileBlobFromStrips(strips, W, H, levelWidth, levelHeight, col, row, tileCols, tileRows);
          }
          if (!blob) continue;

          tileBlobs.push({ path: 'schema_files/' + level + '/' + col + '_' + row + '.jpeg', blob });
          generated++;

          // Mettre à jour le progress toutes les 20 tuiles
          if (generated % 20 === 0) {
            progress('tiles', dpi + ' DPI — Generation: ' + generated + '/' + totalTiles, generated / totalTiles * 0.3);
          }
        }
      }
    }

    log('Tuiles generees: ' + generated);

    // Générer le preview aussi (avant de libérer les strips)
    const previewCanvas = createPreview(strips, W, H, 2000);
    const previewBlob = await new Promise(r => previewCanvas.toBlob(r, 'image/png'));

    // Libérer les strips (grosse mémoire)
    strips.length = 0;

    // ============================================================
    // PHASE 2 : Uploader tout vers Supabase
    // (les canvas sont libérés, on n'a que des blobs légers)
    // ============================================================
    await ensureBucket();

    // DZI
    const dziContent = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<Image xmlns="http://schemas.microsoft.com/deepzoom/2008"\n' +
      '       Format="jpeg"\n' +
      '       Overlap="' + OVERLAP + '"\n' +
      '       TileSize="' + TILE_SIZE + '">\n' +
      '  <Size Width="' + W + '" Height="' + H + '"/>\n' +
      '</Image>';
    await uploadToStorage('schema.dzi', new Blob([dziContent], { type: 'application/xml' }), 'application/xml');

    let uploaded = 0;
    const startTime = Date.now();

    for (let i = 0; i < tileBlobs.length; i += 3) {
      const batch = tileBlobs.slice(i, i + 3).map(t => uploadToStorage(t.path, t.blob, 'image/jpeg'));
      await Promise.all(batch);
      uploaded += batch.length;
      await sleep(80);

      const elapsed = (Date.now() - startTime) / 1000;
      const elapsedStr = formatTime(Math.round(elapsed));
      const rate = uploaded / elapsed;
      const remaining = rate > 0 ? Math.round((tileBlobs.length - uploaded) / rate) : 0;
      const etaStr = formatTime(remaining);
      progress('tiles', dpi + ' DPI — Upload: ' + uploaded + '/' + tileBlobs.length + ' — ' + elapsedStr + ' ecoule — ~' + etaStr + ' restant',
        0.3 + (uploaded / tileBlobs.length) * 0.7);
    }

    // Preview (déjà généré avant la libération des strips)
    await uploadToStorage('schema_preview.png', previewBlob, 'image/png');

    // Meta
    await Store.set('eic_schema_meta', {
      source: 'supabase',
      updated: new Date().toISOString(),
      width: W,
      height: H,
      dpi: dpi,
      complete: true,
    });

    const totalTime = formatTime(Math.round((Date.now() - startTime) / 1000));
    log(dpi + ' DPI termine: ' + uploaded + ' tuiles en ' + totalTime);

    return { uploaded, totalTiles, width: W, height: H };
  }

  /**
   * Rendre le PDF à un DPI spécifique (wrapper de renderPdfChunked)
   */
  async function renderPdfAtDpi(file, dpi) {
    await loadPdfJs();
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });

    const scale = dpi / 72;
    const fullW = Math.floor(viewport.width * scale);
    const fullH = Math.floor(viewport.height * scale);
    const totalPixels = fullW * fullH;

    const MAX_SINGLE_CANVAS = 50_000_000; // 50M px — limite safe Firefox
    const MAX_CANVAS_DIM = 16384;        // max pixels par côté (texture GPU)

    if (totalPixels <= MAX_SINGLE_CANVAS && fullW <= MAX_CANVAS_DIM && fullH <= MAX_CANVAS_DIM) {
      // Image assez petite → rendu direct en un seul canvas
      log('Rendu ' + dpi + ' DPI: ' + fullW + 'x' + fullH + ' px (canvas unique)');
      const canvas = document.createElement('canvas');
      canvas.width = fullW;
      canvas.height = fullH;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, fullW, fullH);
      const scaledViewport = page.getViewport({ scale });
      await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;

      // Copier les pixels dans un canvas NEUF (pdf.js corrompt le canvas original
      // rendant drawImage impossible dans Firefox malgré des pixels valides)
      const imageData = ctx.getImageData(0, 0, fullW, fullH);
      canvas.width = 1; canvas.height = 1; // libérer l'original
      const cleanCanvas = document.createElement('canvas');
      cleanCanvas.width = fullW;
      cleanCanvas.height = fullH;
      cleanCanvas.getContext('2d').putImageData(imageData, 0, 0);
      log('Rendu termine');
      return { strips: [{ x: 0, width: fullW, canvas: cleanCanvas }], width: fullW, height: fullH };
    }

    // Image trop grande → rendu par bandes verticales
    const MAX_STRIP_PIXELS = 40_000_000;
    const stripMaxW = Math.min(8192, Math.floor(MAX_STRIP_PIXELS / fullH));
    const numStrips = Math.ceil(fullW / stripMaxW);

    log('Rendu ' + dpi + ' DPI: ' + fullW + 'x' + fullH + ' px en ' + numStrips + ' bande(s)');

    const strips = [];
    for (let i = 0; i < numStrips; i++) {
      const sx = i * stripMaxW;
      const sw = Math.min(stripMaxW, fullW - sx);
      const canvas = document.createElement('canvas');
      canvas.width = sw;
      canvas.height = fullH;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, sw, fullH);

      const stripViewport = page.getViewport({ scale, offsetX: -sx, offsetY: 0 });
      await page.render({ canvasContext: ctx, viewport: stripViewport }).promise;

      // Copier dans un canvas neuf (pdf.js corrompt l'original)
      const stripData = ctx.getImageData(0, 0, sw, fullH);
      canvas.width = 1; canvas.height = 1;
      const cleanStrip = document.createElement('canvas');
      cleanStrip.width = sw;
      cleanStrip.height = fullH;
      cleanStrip.getContext('2d').putImageData(stripData, 0, 0);

      strips.push({ x: sx, width: sw, canvas: cleanStrip });
      log('  Bande ' + (i + 1) + '/' + numStrips);
    }

    return { strips, width: fullW, height: fullH };
  }

  function formatTime(seconds) {
    if (seconds < 60) return seconds + 's';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m + 'min' + (s > 0 ? ' ' + s + 's' : '');
  }

  /**
   * Process principal : upload progressif 100 → 200 → 300 DPI
   * Le premier palier (100 DPI) est rapide, les suivants tournent en arrière-plan
   */
  async function processUpdate(file, progressCb) {
    const progress = progressCb || (() => {});
    const DPI_STAGES = [72, 150, 300];

    for (let i = 0; i < DPI_STAGES.length; i++) {
      const dpi = DPI_STAGES[i];
      const isFirst = i === 0;

      log('');
      log('=== Passe ' + (i + 1) + '/' + DPI_STAGES.length + ' : ' + dpi + ' DPI ===');

      const result = await generateAndUploadTiles(file, dpi, progress);

      if (isFirst) {
        // Premier palier terminé → le schema est utilisable
        progress('stage-done', 'Schema mis a jour (' + dpi + ' DPI). Amelioration en cours...', 1);
        return { changed: result.uploaded, total: result.totalTiles, skipped: 0, nextStages: DPI_STAGES.slice(1), file };
      }
    }

    log('');
    log('Toutes les passes terminees (300 DPI)');
    progress('done', 'Mise a jour terminee en qualite maximale (300 DPI).', 1);
    return { changed: 0, total: 0, skipped: 0 };
  }

  /**
   * Obtenir le tile source pour OpenSeadragon (Supabase ou local)
   */
  async function getTileSource() {
    const meta = Store.getJSON('eic_schema_meta', null);
    if (meta && meta.source === 'supabase') {
      // Vérifier que le DZI existe dans Supabase
      const dziUrl = SUPABASE_URL + '/storage/v1/object/public/' + STORAGE_BUCKET + '/schema.dzi';
      try {
        const resp = await fetch(dziUrl, { method: 'HEAD' });
        if (resp.ok) {
          return dziUrl;
        }
      } catch { /* fallback local */ }
    }
    return null; // le main.js utilisera la source locale
  }

  /**
   * Rendu de l'UI dans le panneau Paramètres
   */
  function renderSettingsTab(container) {
    const meta = Store.getJSON('eic_schema_meta', null) || {};
    const lastUpdate = meta.updated || null;
    const dims = (meta.width && meta.height) ? meta : null;
    const source = meta.source || 'local';

    container.innerHTML = `
      <div style="padding:12px;">
        <div style="margin-bottom:16px;">
          <div style="font-size:13px;font-weight:600;color:var(--accent2);margin-bottom:8px;">Source actuelle</div>
          <div style="font-size:12px;color:var(--muted);">
            ${source === 'supabase' ? 'Supabase Storage (cloud)' : 'Fichiers locaux (/tiles/)'}
            ${lastUpdate ? '<br>Derniere MAJ: ' + new Date(lastUpdate).toLocaleString('fr-FR') : ''}
            ${dims ? '<br>Dimensions: ' + dims.width + ' x ' + dims.height + ' px' : ''}
          </div>
        </div>

        <div style="border:1px dashed var(--border2);border-radius:8px;padding:20px;text-align:center;margin-bottom:12px;cursor:pointer;transition:border-color 0.2s;" id="schema-drop-zone">
          <div style="font-size:24px;margin-bottom:8px;">PDF</div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:12px;">
            Glissez le nouveau PDF ici<br>ou cliquez pour parcourir
          </div>
          <input type="file" id="schema-file-input" accept=".pdf" style="display:none;">
          <button id="schema-browse-btn" style="padding:6px 16px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-family:var(--mono);">
            Choisir le PDF
          </button>
        </div>

        <div id="schema-file-info" class="hidden" style="background:var(--surface2);border-radius:6px;padding:10px;margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span id="schema-file-name" style="font-size:12px;font-family:var(--mono);"></span>
            <button id="schema-file-clear" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px;">x</button>
          </div>
        </div>

        <button id="schema-update-btn" class="hidden" style="width:100%;padding:10px;background:var(--accent2);color:#000;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;font-family:var(--mono);">
          Mettre a jour le schema
        </button>

        <div id="schema-progress" class="hidden" style="margin-top:12px;">
          <div style="background:var(--surface2);border-radius:4px;overflow:hidden;height:6px;margin-bottom:8px;">
            <div id="schema-progress-bar" style="height:100%;background:var(--accent2);width:0%;transition:width 0.3s;"></div>
          </div>
          <div id="schema-progress-text" style="font-size:11px;color:var(--muted);font-family:var(--mono);"></div>
        </div>

        <div id="schema-log" class="hidden" style="margin-top:12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:11px;font-family:var(--mono);max-height:200px;overflow-y:auto;white-space:pre-wrap;color:var(--muted);"></div>

        <div style="margin-top:16px;border-top:1px solid var(--border);padding-top:12px;">
          <button id="schema-revert-btn" style="padding:6px 12px;background:var(--surface2);color:var(--muted);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:11px;font-family:var(--mono);"
            ${source !== 'supabase' ? 'disabled style="opacity:0.4;pointer-events:none;"' : ''}>
            Revenir aux tuiles locales
          </button>
        </div>
      </div>
    `;

    // Event listeners
    const dropZone = document.getElementById('schema-drop-zone');
    const fileInput = document.getElementById('schema-file-input');
    const browseBtn = document.getElementById('schema-browse-btn');
    const fileInfo = document.getElementById('schema-file-info');
    const fileName = document.getElementById('schema-file-name');
    const fileClear = document.getElementById('schema-file-clear');
    const updateBtn = document.getElementById('schema-update-btn');
    const progressDiv = document.getElementById('schema-progress');
    const progressBar = document.getElementById('schema-progress-bar');
    const progressText = document.getElementById('schema-progress-text');
    const logDiv = document.getElementById('schema-log');
    const revertBtn = document.getElementById('schema-revert-btn');

    let selectedFile = null;

    function selectFile(file) {
      if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
        alert('Veuillez selectionner un fichier PDF.');
        return;
      }
      selectedFile = file;
      fileName.textContent = file.name + ' (' + (file.size / 1024 / 1024).toFixed(1) + ' Mo)';
      fileInfo.classList.remove('hidden');
      updateBtn.classList.remove('hidden');
      dropZone.style.borderColor = 'var(--accent2)';
    }

    browseBtn.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('click', (e) => {
      if (e.target === dropZone || e.target.parentNode === dropZone) fileInput.click();
    });

    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) selectFile(fileInput.files[0]);
    });

    // Drag & drop
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.style.borderColor = 'var(--accent)';
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.style.borderColor = selectedFile ? 'var(--accent2)' : 'var(--border2)';
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer.files.length > 0) selectFile(e.dataTransfer.files[0]);
    });

    fileClear.addEventListener('click', () => {
      selectedFile = null;
      fileInfo.classList.add('hidden');
      updateBtn.classList.add('hidden');
      dropZone.style.borderColor = 'var(--border2)';
      fileInput.value = '';
    });

    updateBtn.addEventListener('click', async () => {
      if (!selectedFile) return;

      updateBtn.disabled = true;
      updateBtn.textContent = 'Traitement en cours...';
      progressDiv.classList.remove('hidden');
      logDiv.classList.remove('hidden');
      logDiv.textContent = '';
      _log = logDiv;

      showFloating('Preparation...', 0);

      try {
        const result = await processUpdate(selectedFile, (phase, msg, pct) => {
          progressText.textContent = msg;
          showFloating(msg, pct);
          if (typeof pct === 'number') {
            progressBar.style.width = Math.round(pct * 100) + '%';
          }
        });

        if (result.nextStages && result.nextStages.length > 0) {
          // Premier palier terminé — proposer de recharger + lancer la suite en arrière-plan
          progressBar.style.width = '100%';
          progressBar.style.background = 'var(--accent2)';
          updateBtn.textContent = 'Recharger (100 DPI disponible)';
          updateBtn.disabled = false;
          updateBtn.onclick = () => location.reload();

          // Lancer les passes suivantes en arrière-plan
          log('');
          log('Amelioration en arriere-plan...');
          runBackgroundUpgrade(result.file, result.nextStages, progressText, progressBar);
        } else if (result.changed > 0) {
          progressBar.style.width = '100%';
          progressBar.style.background = 'var(--accent2)';
          updateBtn.textContent = 'Recharger l\'application';
          updateBtn.disabled = false;
          updateBtn.onclick = () => location.reload();
        } else {
          updateBtn.textContent = 'Aucun changement';
        }
      } catch (err) {
        log('ERREUR: ' + err.message);
        progressText.textContent = 'Erreur: ' + err.message;
        progressBar.style.background = 'var(--danger)';
        updateBtn.textContent = 'Reessayer';
        updateBtn.disabled = false;
      }
    });

    /** Amélioration progressive en arrière-plan (200 → 300 DPI) */
    async function runBackgroundUpgrade(file, stages, textEl, barEl) {
      for (let i = 0; i < stages.length; i++) {
        const dpi = stages[i];
        try {
          await generateAndUploadTiles(file, dpi, (phase, msg, pct) => {
            const bgMsg = 'Arriere-plan: ' + msg;
            if (textEl) textEl.textContent = bgMsg;
            if (barEl && typeof pct === 'number') barEl.style.width = Math.round(pct * 100) + '%';
            showFloating(bgMsg, pct);
          });
          log(dpi + ' DPI termine');
        } catch (err) {
          log('Erreur ' + dpi + ' DPI: ' + err.message + ' (sera reessaye au prochain upload)');
        }
      }
      if (textEl) textEl.textContent = 'Qualite maximale (300 DPI) atteinte !';
      if (barEl) { barEl.style.width = '100%'; barEl.style.background = 'var(--accent2)'; }
      updateFloatingDone();
      _log = null;
    }

    revertBtn.addEventListener('click', async () => {
      await Store.set('eic_schema_meta', { source: 'local' });
      location.reload();
    });
  }

  return { processUpdate, generateAndUploadTiles, getTileSource, renderSettingsTab, loadPdfJs };
})();
