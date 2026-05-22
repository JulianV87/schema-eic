/**
 * Templates de situations types
 * Pré-configure les annotations selon le type d'incident
 */
const Templates = (() => {
  // Templates vides — le système de mots-clés sera re-rempli quand l'utilisateur fournira sa liste.
  const TEMPLATES = {};

  function apply(templateId, element, parsed) {
    const template = TEMPLATES[templateId];
    if (!template) return;
    template.actions(element, parsed);
  }

  function getTemplate(id) { return TEMPLATES[id]; }

  return { apply, getTemplate };
})();
