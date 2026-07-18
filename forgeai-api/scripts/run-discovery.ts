import { runDiscovery } from '../src/workers/discovery.worker'

runDiscovery()
  .then(() => {
    console.log('[run-discovery] Done.')
    process.exit(0)
  })
  .catch((e) => {
    console.error('[run-discovery] Failed:', e)
    process.exit(1)
  })
