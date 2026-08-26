import test from 'ava'
import { EventEmitter } from 'node:events'
import { onlineManager } from '@tanstack/query-core'
import { RpcDataCache, rpcOnlineFrom, type RpcDataAnswer } from './Cache.js'
import type { RpcQuestion } from './Key.js'

/**
 * Offline means *this link*.
 *
 * Its own file because `onlineManager` is a module singleton and these tests take it offline: a
 * neighbour running concurrently would find its requests paused for reasons it never asked for.
 * Which is itself worth knowing about the thing being tested - it is global, and a process with two
 * links has to decide which one speaks for it rather than letting the last one wired win.
 *
 * Serial for the same reason one level down: ava runs the tests inside a file concurrently, and the
 * second of these putting the manager back online resumed the first one's paused request.
 */

const tags: RpcQuestion = { target: 'oven3', namespace: 'oven', method: 'getList', resource: ['state', 'tags'] }
const answer: RpcDataAnswer = { data: ['a'], ids: ['a'], total: 1, epoch: 'e1', revision: 1 }
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test.afterEach(() => {
    onlineManager.setEventListener(() => undefined)
    onlineManager.setOnline(true)
})

test.serial('a request made while the link is down waits for the link, and is not spent on it', async (t) => {
    // A browser on a plant LAN with no route to the peer reports itself online, and a laptop whose
    // Wi-Fi dropped reports itself offline while the plant is reachable over Ethernet. The link
    // itself knows, says so on every transition including reconnects, and is the same source in
    // Node and in a browser.
    const link = new EventEmitter()
    const asked: RpcQuestion[] = []
    const cache = new RpcDataCache({
        ask: async (question) => {
            asked.push(question)
            return answer
        },
        lifecycle: link
    })

    link.emit('disconnected')
    const pending = cache.fetch(tags)
    await wait(50)
    t.is(asked.length, 0, 'paused, rather than issued at a transport that already knows it cannot send')

    link.emit('connected')
    t.deepEqual((await pending).ids, ['a'])
    t.is(asked.length, 1)
    cache.close()
})

test.serial('undoing the wiring leaves the cache able to ask again', async (t) => {
    const link = new EventEmitter()
    const undo = rpcOnlineFrom(link)
    link.emit('disconnected')
    t.false(onlineManager.isOnline())
    undo()
    t.true(onlineManager.isOnline(), 'a link that is gone must not leave every later request paused')
})
