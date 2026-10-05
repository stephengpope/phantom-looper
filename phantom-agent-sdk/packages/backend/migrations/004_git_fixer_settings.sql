-- The Git Fixer's model trio joins the per-agent cascade (core agentModelConfig):
-- provider/model/base_url renamed auto_push_fix_* -> git_fixer_*, null now
-- meaning "the coding agent's" rather than a pinned default. Stored overrides
-- carry over under the new names and keep their exact effect — an explicit
-- 'anthropic' row behaves the same whether the default under it was a pin or
-- an inheritance. (auto_push_fix_attempts keeps its name: it configures the
-- auto-push flow, not the agent.) No git_fixer_* row can predate this —
-- unknown keys were always refused — so the rename cannot collide.
update phantom_looper.settings
   set key = 'git_fixer_' || substr(key, char_length('auto_push_fix_') + 1)
 where key in ('auto_push_fix_provider', 'auto_push_fix_model', 'auto_push_fix_base_url');
