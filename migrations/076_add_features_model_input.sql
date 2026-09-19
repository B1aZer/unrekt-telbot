-- Store actual feature values fed to model (after fillna/imputer)
-- features_json = raw input (with nulls), features_model_input = what model actually received
ALTER TABLE hybrid_shadow_decisions ADD COLUMN IF NOT EXISTS features_model_input jsonb;
