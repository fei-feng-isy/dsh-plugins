# docs/

The merged repository keeps each subtree's documentation next to its code; this directory is the
place for anything that is about the WORKSPACE as a whole.

- `RELEASING.md` — how the three packages are released from THIS checkout (base → plugins), why the
  `../dsh-plugins-rc` projection was retired, and the publish-time assertions
  (`scripts/prepublish-assert.mjs`) that replaced its three differences.
- `CLOSURE-TIERS.md` — the two closure tiers (`pnpm check:fast` / `pnpm check:release`): what each
  covers and does not, the dedup, the measured before/after wall-clock, the mutation check that keeps
  the fast tier honest, and the parallelism verdict for the three trees.
- `review/` — the code-review records, one file per review, oldest first (`YYYY-MM-DD-<topic>.md`).
  They cover the workspace (or a subtree of it), quote internals freely and are **deliberately not
  committed** (see the rule in `../.gitignore`): they are kept in the working tree for reference and
  go stale as the code moves. A review of `mission/` finds them next to the workspace, not next to the
  subtree, because later rounds span subtrees.
- `../AGENTS.md` — the workspace contract: publish surface, the three family hard constraints, the
  "can ONE base release fix this?" rule, degradation when the base is missing, and the gates to run.
- `../base/plugin-base/README.md`, `../base/plugin-base/docs/DESIGN.md` and
  `../base/plugin-base/docs/INTERFACE.md` — the family base (environment initialisation +
  compatibility gate + kit), and the public-interface freeze / version policy that decides when a
  base release is a major (interface), a minor (behaviour) or a patch.
- `../mem/README.md`, `../mem/DESIGN.md`, `../mem/docs/*` — the memory/knowledge plugin. `INSTALL.md`,
  `PROVISIONING.md` and `RELEASING.md` describe the merged base+plugin install/publish flow.
- `../mission/README.md`, `../mission/docs/**` — the mission-tree plugin.
