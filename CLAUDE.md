@AGENTS.md

# CLAUDE.md: Git Control Pointer

`AGENTS.md` is the single source of truth for all project rules, invariants, and operational workflows; write all rules there, never here.

Key rules to respect:
- Quality gates: `npm test` and `npm run typecheck` must pass cleanly. See `## Testing Standards`.
- Workflow: Work on a new branch from `main`; never merge without explicit user approval. See `## Git & Release Workflow`.
- Documentation style: Zero em dashes, zero en dashes, zero `--` as punctuation in prose, zero emojis; keep `--` intact in code and commands. See `## Documentation Style`.

Maintenance: When rules change, edit `AGENTS.md`; never add rules directly to `CLAUDE.md`.
