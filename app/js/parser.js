/**
 * Parser de la barre de commande
 * Décompose une commande texte libre en structure exploitable
 */
const Parser = (() => {
  // Types d'éléments infra reconnus
  const INFRA_TYPES = {
    'aig': 'aiguille',
    'pn': 'pn',
    'cv': 'cv',
    'c': 'signal',
  };

  // Mots-clés → template (vide — à remplir quand l'utilisateur fournira sa liste)
  const TEMPLATE_KEYWORDS = {};

  // Patterns regex pour les éléments infra
  const PATTERNS = {
    infra: /\b(aig|pn|cv)\s*(\d{1,5}[a-z]?)\b/i,
    signal: /\b(c)\s*(\d{3,5}[a-z]?)\b/i,
    pk: /\bkm\s*(\d{1,3}[,\.]\d{1,3})\b/i,
    train: /\b(?:train\s*)?(\d{5,6})\b/,
  };

  // Liste des gares (chargée depuis Data au démarrage)
  let gares = [];

  // Normalise : minuscules + strip accents + nettoyage basique
  function norm(s) {
    return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  // Distance de Levenshtein (itérative, complexité O(n*m))
  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const prev = new Array(a.length + 1);
    const curr = new Array(a.length + 1);
    for (let j = 0; j <= a.length; j++) prev[j] = j;
    for (let i = 1; i <= b.length; i++) {
      curr[0] = i;
      for (let j = 1; j <= a.length; j++) {
        const cost = b.charCodeAt(i - 1) === a.charCodeAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      }
      for (let j = 0; j <= a.length; j++) prev[j] = curr[j];
    }
    return prev[a.length];
  }

  // Cherche la gare la plus proche d'un token (distance ≤ 2 pour mots ≥ 4 chars)
  function fuzzyFindGare(token) {
    const n = norm(token);
    if (n.length < 3) return null;
    const maxDist = n.length >= 5 ? 2 : 1;
    let best = null, bestDist = Infinity;
    for (const g of gares) {
      const candidates = [g.nom_norm, g.nom_court_norm].filter(Boolean);
      for (const cand of candidates) {
        // Si le token apparaît en sous-chaîne → distance 0
        if (cand.includes(n)) {
          if (0 < bestDist) { best = g; bestDist = 0; }
          continue;
        }
        const d = levenshtein(n, cand);
        if (d <= maxDist && d < bestDist) { best = g; bestDist = d; }
      }
    }
    return best;
  }

  function init(garesData) {
    gares = garesData.map(g => ({
      nom: g.nom.toLowerCase(),
      nom_court: (g.nom_court || '').toLowerCase(),
      nom_norm: norm(g.nom),
      nom_court_norm: norm(g.nom_court || ''),
      data: g
    }));
    // Tri par longueur décroissante pour matcher les noms longs d'abord
    gares.sort((a, b) => b.nom.length - a.nom.length);
  }

  function parse(input) {
    const raw = input.toLowerCase().trim();
    const result = {
      type: null,
      identifiant: null,
      contexte: null,
      template: null,
      trainNumber: null,
      message: '',
      raw: input.trim()
    };

    let remaining = raw;

    // 1. Extraire l'élément infra D'ABORD (avant le train, pour éviter de matcher un PK comme n° train)
    const infraMatch = remaining.match(PATTERNS.infra);
    const signalMatch = remaining.match(PATTERNS.signal);
    const pkMatch = remaining.match(PATTERNS.pk);

    if (infraMatch) {
      result.type = INFRA_TYPES[infraMatch[1].toLowerCase()] || infraMatch[1];
      result.identifiant = infraMatch[0].replace(/\s+/g, ' ').trim();
      remaining = remaining.replace(infraMatch[0], ' ');
    } else if (signalMatch) {
      result.type = 'signal';
      result.identifiant = signalMatch[0].replace(/\s+/g, ' ').trim();
      remaining = remaining.replace(signalMatch[0], ' ');
    } else if (pkMatch) {
      result.type = 'pk';
      result.identifiant = 'km ' + pkMatch[1];
      remaining = remaining.replace(pkMatch[0], ' ');
    }

    // 2. Extraire le numéro de train (APRÈS infra, exiger préfixe "train" ou contexte)
    const trainWithPrefix = remaining.match(/\btrain\s*(\d{4,6})\b/);
    const trainBare = remaining.match(/\b(\d{5,6})\b/);
    if (trainWithPrefix) {
      result.trainNumber = trainWithPrefix[1];
      remaining = remaining.replace(trainWithPrefix[0], ' ');
    } else if (trainBare) {
      result.trainNumber = trainBare[1];
      remaining = remaining.replace(trainBare[0], ' ');
    }

    // 3. Extraire la gare (contexte) — recherche exacte + normalisée, puis fuzzy en fallback
    const remainingNorm = norm(remaining);
    let matchedNorm = null;
    for (const gare of gares) {
      // Essai normalisé (gère les accents manquants : "crepy" ↔ "crépy")
      const nomN = gare.nom_norm;
      if (nomN && new RegExp('\\b' + nomN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(remainingNorm)) {
        result.contexte = gare.data;
        matchedNorm = nomN;
        break;
      }
      const courtN = gare.nom_court_norm;
      if (courtN && new RegExp('\\b' + courtN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(remainingNorm)) {
        result.contexte = gare.data;
        matchedNorm = courtN;
        break;
      }
    }
    if (matchedNorm) {
      // Retirer grossièrement la gare du "remaining" — par mot, tolérant aux accents
      remaining = remaining.split(/\s+/).filter(w => norm(w) !== matchedNorm && !matchedNorm.includes(norm(w))).join(' ');
    } else {
      // Fallback fuzzy : tester chaque mot restant contre les gares (distance ≤ 2)
      const words = remaining.split(/\s+/).filter(w => w.length >= 3);
      for (const w of words) {
        const g = fuzzyFindGare(w);
        if (g) {
          result.contexte = g.data;
          remaining = remaining.replace(new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b'), ' ');
          break;
        }
      }
    }

    // 4. Détecter le template — comparaison normalisée (tolère accents manquants)
    const remainingForKeyword = norm(remaining);
    for (const [keyword, template] of Object.entries(TEMPLATE_KEYWORDS)) {
      if (remainingForKeyword.includes(norm(keyword))) {
        result.template = template;
        break;
      }
    }

    // 5. Le reste = message d'annotation
    result.message = remaining.replace(/\s+/g, ' ').trim();

    return result;
  }

  return { init, parse };
})();
