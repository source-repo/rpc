import { parentPort, workerData, type MessagePort } from 'node:worker_threads'
import { MessagePortTransport, rpc, RpcServer, rpcNamespace } from '../../index.js'

/**
 * A peer of its own, on a worker thread.
 *
 * Not a component somebody else hosts: a whole `RpcServer` with a name, exposing a class, reachable
 * by that name from the other side of a `MessagePort`. What makes it a peer rather than a hosted
 * instance is that it also calls *out* - `askBack` addresses a peer it has only ever heard of
 * through this link's presence, and the frame is routed there by whatever is on the other end.
 */

const { port, name, partner } = workerData as { port: MessagePort; name: string; partner: string }

@rpcNamespace('kettle')
class Kettle {
    @rpc({ semantics: 'query', effect: 'observe' })
    boil(litres: number): string {
        return `boiling ${litres} litres on a thread of my own`
    }

    /** Calls back across the same link, to a peer this worker knows only from presence. */
    @rpc({ semantics: 'query', effect: 'observe' })
    async askBack(): Promise<string> {
        const gauge = await server.proxy<{ ping(): Promise<string> }>('gauge', partner)
        return gauge.ping()
    }
}

// The transport is built first and handed to the server, which attaches it like any other: shared
// peer registry, piped to both handlers, presence wired. Nothing about the server knows this link
// is a thread rather than a socket.
const link = new MessagePortTransport(name, port)
const server = new RpcServer({ name, transports: [link] })
server.exposeClassInstance(new Kettle(), 'kettle')
void server.ready().then(() => parentPort?.postMessage({ up: true }))
