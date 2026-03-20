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

  // Mots-clés → template
  const TEMPLATE_KEYWORDS = {
    'absence': 'aiguille_defaillante',
    'derangement': 'element_derangement',
    'immobilise': 'train_immobilise',
    'immobilisé': 'train_immobilise',
    'retenu': 'train_retenu_quai',
    'arrete': 'train_arrete_pleine_voie',
    'arrêté': 'train_arrete_pleine_voie',
    'coupee': 'voie_coupee',
    'coupée': 'voie_coupee',
    'bloquee': 'voie_coupee',
    'bloquée': 'voie_coupee',
    'ralentissement': 'ralentissement',
    'limitation': 'ralentissement',
    'ltv': 'ralentissement',
    'catenaire': 'incident_catenaire',
    'caténaire': 'incident_catenaire',
    'accident': 'accident_personne',
    'personne': 'accident_personne',
    'heurte': 'accident_personne',
    'occupee': 'voie_occupee',
    'occupée': 'voie_occupee',
    'canton': 'voie_occupee',
  };

  // Patterns regex pour les éléments infra
  const PATTERNS = {
    infra: /\b(aig|pn|cv)\s*(\d{1,5}[a-z]?)\b/i,
    signal: /\b(c)\s*(\d{3,5}[a-z]?)\b/i,
    pk: /\bkm\s*(\d{1,3}[,\.]\d{1,3})\b/i,
    train: /\b(?:train\s*)?(\d{5,6})\b/,
  };

  // Liste des gares (chargée depuis Data au démarrage)
  let gares = [];

  function init(garesData) {
    gares = garesData.map(g => ({
      nom: g.nom.toLowerCase(),
      nom_court: (g.nom_court || '').toLowerCase(),
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

    // 3. Extraire la gare (contexte) — word boundary pour éviter faux positifs
    for (const gare of gares) {
      const escapedNom = gare.nom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const nomRegex = new RegExp('\\b' + escapedNom + '\\b');
      if (nomRegex.test(remaining)) {
        result.contexte = gare.data;
        remaining = remaining.replace(nomRegex, ' ');
        break;
      }
      if (gare.nom_court) {
        const escapedCourt = gare.nom_court.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const courtRegex = new RegExp('\\b' + escapedCourt + '\\b');
        if (courtRegex.test(remaining)) {
          result.contexte = gare.data;
          remaining = remaining.replace(courtRegex, ' ');
          break;
        }
      }
    }

    // 4. Détecter le template (word boundary)
    for (const [keyword, template] of Object.entries(TEMPLATE_KEYWORDS)) {
      if (remaining.includes(keyword)) {
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
