/**
 * Templates de situations types
 * Pré-configure les annotations selon le type d'incident
 */
const Templates = (() => {
  const TEMPLATES = {
    aiguille_defaillante: {
      name: 'Aiguille défaillante',
      actions: (element, parsed) => {
        Annotations.highlightElement(element, parsed.message || 'Aiguille en dérangement');
      }
    },
    element_derangement: {
      name: 'Élément en dérangement',
      actions: (element, parsed) => {
        Annotations.highlightElement(element, parsed.message || 'En dérangement');
      }
    },
    train_immobilise: {
      name: 'Train immobilisé pleine voie',
      actions: (element, parsed) => {
        if (element) Annotations.highlightElement(element, parsed.message);
        if (parsed.trainNumber) {
          const x = element ? element.x_pct : 0.5;
          const y = element ? element.y_pct + 0.01 : 0.5;
          Annotations.addTrainAnnotation('train-immobilise', x, y, parsed.trainNumber);
        }
      }
    },
    train_retenu_quai: {
      name: 'Train retenu à quai',
      actions: (element, parsed) => {
        if (parsed.trainNumber) {
          const x = element ? element.x_pct : 0.5;
          const y = element ? element.y_pct : 0.5;
          Annotations.addTrainAnnotation('train-retenu', x, y, parsed.trainNumber);
        }
      }
    },
    train_arrete_pleine_voie: {
      name: 'Train arrêté pleine voie',
      actions: (element, parsed) => {
        if (parsed.trainNumber) {
          const x = element ? element.x_pct : 0.5;
          const y = element ? element.y_pct + 0.01 : 0.5;
          Annotations.addTrainAnnotation('train-arrete', x, y, parsed.trainNumber);
        }
      }
    },
    voie_coupee: {
      name: 'Voie coupée',
      actions: (element, parsed) => {
        if (element) Annotations.highlightElement(element, parsed.message || 'Voie coupée');
      }
    },
    ralentissement: {
      name: 'Ralentissement / LTV',
      actions: (element, parsed) => {
        if (element) Annotations.highlightElement(element, parsed.message || 'Ralentissement');
      }
    },
    incident_catenaire: {
      name: 'Incident caténaire',
      actions: (element, parsed) => {
        if (element) Annotations.highlightElement(element, parsed.message || 'Incident caténaire');
      }
    },
    accident_personne: {
      name: 'Accident de personne',
      actions: (element, parsed) => {
        if (element) Annotations.highlightElement(element, parsed.message || 'Accident de personne');
      }
    },
    voie_occupee: {
      name: 'Voie occupée / Canton',
      actions: (element, parsed) => {
        if (element) Annotations.highlightElement(element, parsed.message || 'Voie occupée');
      }
    },
  };

  function apply(templateId, element, parsed) {
    const template = TEMPLATES[templateId];
    if (!template) return;
    template.actions(element, parsed);
  }

  function getTemplate(id) { return TEMPLATES[id]; }

  return { apply, getTemplate };
})();
