# docs/

The merged repository keeps each subtree's documentation next to its code; this directory is the
place for anything that is about the WORKSPACE as a whole.

- `review/` — the code-review records, one file per review, oldest first (`YYYY-MM-DD-<topic>.md`).
  They cover the workspace (or a subtree of it), quote internals freely and are **deliberately not
  committed** (see the rule in `../.gitignore`): they are kept in the working tree for reference and
  go stale as the code moves. A review of `work/` finds them next to the workspace, not next to the
  subtree, because later rounds span subtrees.
- `../AGENTS.md` — the workspace contract: publish surface, the three family hard constraints, the
  "can ONE base release fix this?" rule, degradation when the base is missing, and the gates to run.
- `../base/plugin-base/README.md`, `../base/plugin-base/docs/DESIGN.md` and
  `../base/plugin-base/docs/INTERFACE.md` — the family base (environment initialisation +
  compatibility gate + kit), and the public-interface freeze / version policy that decides when a
  base release is a major (interface), a minor (behaviour) or a patch.
- `../mem/README.md`, `../mem/DESIGN.md`, `../mem/docs/*` — the memory/knowledge plugin. `INSTALL.md`,
  `PROVISIONING.md` and `RELEASING.md` describe the merged base+plugin install/publish flow.
- `../work/README.md`, `../work/docs/**` — the work-tree plugin.
