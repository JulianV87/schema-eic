-- Table de configuration clé-valeur (miroir du localStorage)
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Mettre à jour updated_at automatiquement
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER config_updated
  BEFORE UPDATE ON config
  FOR EACH ROW
  EXECUTE FUNCTION update_timestamp();

-- Permettre l'accès en lecture/écriture à tout le monde (anon)
-- Pour un usage multi-utilisateur sécurisé, on ajoutera l'auth plus tard
ALTER TABLE config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Accès public lecture" ON config
  FOR SELECT USING (true);

CREATE POLICY "Accès public écriture" ON config
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Accès public modification" ON config
  FOR UPDATE USING (true);

CREATE POLICY "Accès public suppression" ON config
  FOR DELETE USING (true);
