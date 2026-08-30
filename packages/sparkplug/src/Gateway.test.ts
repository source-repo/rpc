import test from 'ava'
import { sourceSparkGatewayClientIds } from './Gateway.js'

test('dual-session client IDs are deterministic and distinct', (t) => {
    t.deepEqual(sourceSparkGatewayClientIds('plant-edge-01'), {
        rpc: 'plant-edge-01-rpc',
        sparkplug: 'plant-edge-01-sparkplug'
    })
})

test('dual-session runtime IDs are safe Source RPC topic segments', (t) => {
    for (const runtimeId of ['', 'site/edge', 'site+edge', 'site#edge', `site\0edge`]) t.throws(() => sourceSparkGatewayClientIds(runtimeId))
    t.throws(() => sourceSparkGatewayClientIds('x'.repeat(116)), { message: /115 UTF-8 bytes/ })
})
