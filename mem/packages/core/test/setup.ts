/**
 * Spec bootstrap.
 *
 * The ingestion pipeline converts through pandoc, which `@avantf/mem-provision` installs at plugin
 * mount. Under vitest there is no mount, so the provisioning layer is pointed at the per-user managed
 * directory and `PATH` and told NOT to download (the suite-wide kill switch). A missing pandoc is
 * then an explicit failure in the conversion specs, and the specs that need a conversion skip
 * themselves when it is absent — a spec that silently fell back to a text path would be testing the
 * wrong pipeline.
 */
import { defaultLogger } from '@avantf/mem-contract'
import { parseToolsConfig, resolveToolsDir } from '@avantf/mem-provision'
import { setPandocProvisioning } from '@avantf/mem-convert'

setPandocProvisioning({
  toolsDir: resolveToolsDir(parseToolsConfig(undefined)),
  mirror: [],
  autoInstall: false,
  logger: defaultLogger,
})
