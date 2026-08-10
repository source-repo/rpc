import { componentSnapshot, pageEntries, rpc, rpcNamespace, RpcComponent, type RpcDataMethod, type RpcDataResource, type RpcDataResources, type RpcGetListParams, type RpcGetManyParams } from '@source-repo/rpc'
import { DockerEngine, type DockerContainer, type DockerEngineOptions } from './Engine.js'

/**
 * What is running on this host, as an ordinary Source RPC component.
 *
 * A plant box with a handful of containers is far commoner than a cluster, and the question an
 * operator asks about one is nearly always the same: what is running, what stopped, and when. That
 * question deserves an answer over the network the rest of the site already uses, rather than an
 * SSH session.
 *
 * **It reads and never writes, and that boundary is the package.** Write access to the Docker
 * socket is root on the host - there is no namespace to bound it to and no RBAC above it - so a
 * node that could start containers would carry the security posture and the support burden of an
 * orchestration product. Starting things belongs to one of those; this is the half that is small,
 * safe to reason about, and useful on its own.
 *
 * **The counts are state and the containers are a resource**, which is the split the library draws
 * everywhere: how many are running is a bounded fact the contract can name, so it is published as
 * state and a console subscribes to it. *Which* containers exist is data - it changes as things are
 * started elsewhere, and nothing in a contract could enumerate it - so it is a `dataResources()`
 * collection a caller asks for a page of.
 */

export type DockerProps = {
    /** Where this node is looking. Useful on a screen showing several. */
    socketPath: string
    /** What the daemon says it is, once it has been reached. */
    engine?: string
    apiVersion?: string
}

export type DockerState = {
    /** Whether the last look reached the daemon. A host without Docker is a normal thing to be. */
    reachable: boolean
    running: number
    exited: number
    total: number
    /** Why the last look failed, kept readable rather than blanked - the same rule the channel uses. */
    problem?: string
    /** When the counts were last taken, so a stale screen says so. */
    checkedAt: number
}

/** One container, as this package presents it. Flatter than the daemon's own shape, and stable. */
export interface ContainerRow {
    name: string
    image: string
    state: string
    status: string
    created: number
    ports: string
}

@rpcNamespace('docker', { version: '1' })
export class DockerService extends RpcComponent<DockerProps, DockerState> implements RpcDataResources {
    private readonly engine: DockerEngine
    private timer?: NodeJS.Timeout

    constructor(options: DockerEngineOptions & { pollMs?: number } = {}) {
        const engine = new DockerEngine(options)
        super(
            { socketPath: engine.socketPath },
            { reachable: false, running: 0, exited: 0, total: 0, checkedAt: 0 }
        )
        this.engine = engine
        // Counts are state, so they are polled and published; the container list is not, because a
        // caller asks for the page it is showing rather than being sent all of them.
        const pollMs = options.pollMs ?? 10_000
        if (pollMs > 0) {
            this.timer = setInterval(() => void this.refresh(), pollMs)
            this.timer.unref?.()
        }
    }

    /** Take the counts now. Called on a timer, and worth calling once at startup. */
    async refresh(): Promise<DockerState> {
        try {
            const containers = await this.engine.containers()
            const running = containers.filter((one) => one.State === 'running').length
            this.setState({
                reachable: true,
                running,
                exited: containers.filter((one) => one.State === 'exited').length,
                total: containers.length,
                problem: undefined,
                checkedAt: Date.now()
            })
        } catch (e) {
            // Reachability is a fact worth publishing, not an error to throw at whoever polled. A
            // host without Docker is an ordinary thing for this component to be running on.
            this.setState({ reachable: false, problem: (e as Error).message, checkedAt: Date.now() })
        }
        return this.state
    }

    /** What the daemon is, when it can be reached. Answers the props rather than guessing at startup. */
    @rpc({ semantics: 'query' })
    async identify(): Promise<DockerProps> {
        const version = await this.engine.version()
        return { socketPath: this.engine.socketPath, engine: version.Version, apiVersion: version.ApiVersion }
    }

    /**
     * The containers, and nothing that could change one.
     *
     * `getList` and `getMany` only. The verb list is what a viewer offers from, so a resource that
     * declares no action is a resource a console draws no buttons for - which is exactly right here
     * and is enforced by there being no method to call.
     */
    dataResources(): readonly RpcDataResource[] {
        return [
            {
                path: ['containers'],
                label: 'Containers',
                verbs: ['getList', 'getMany'],
                row: {
                    kind: 'object',
                    fields: {
                        name: { type: { kind: 'string' } },
                        image: { type: { kind: 'string' } },
                        state: { type: { kind: 'string' } },
                        status: { type: { kind: 'string' } },
                        created: { type: { kind: 'number' } },
                        ports: { type: { kind: 'string' } }
                    }
                }
            }
        ]
    }

    async dataRequest(method: RpcDataMethod, _resource: readonly string[], params: RpcGetListParams | RpcGetManyParams) {
        const began = Date.now()
        const entries = (await this.engine.containers()).map((one) => [idOf(one), rowOf(one)] as const)
        const queryMs = Date.now() - began
        if (method === 'getMany') {
            const wanted = new Set((params as RpcGetManyParams).ids)
            const found = entries.filter(([id]) => wanted.has(id))
            return { ids: found.map(([id]) => id), data: found.map(([, row]) => row), ...this.stamp(), queryMs }
        }
        // Filtering, ordering and paging through the library's own code rather than a version of
        // it, so `state:exited` means the same thing here as over any other resource. The count is
        // free once the list is held, which is why there is no separate countMs to report.
        return { ...pageEntries(entries, params as RpcGetListParams), ...this.stamp(), queryMs }
    }

    /**
     * Where the answer came from, taken from this component's own snapshot rather than invented.
     *
     * A restart is a new epoch, and that is the reason an answer carries one: a caller paging
     * through needs to know the set was rebuilt underneath it. Making something up here would look
     * identical and tell nobody anything.
     */
    private stamp() {
        const snapshot = componentSnapshot(this)
        return { epoch: snapshot.epoch, revision: snapshot.revision }
    }

    /** Stop polling. A host that exposes this should call it when it shuts down. */
    close() {
        if (this.timer) clearInterval(this.timer)
        this.timer = undefined
    }
}

/**
 * The name a person would use, falling back to the id.
 *
 * Docker's own names arrive with a leading slash and a container may have several; the first is the
 * one every tool shows. A container without one is unusual and is better identified by a short id
 * than by nothing.
 */
const idOf = (container: DockerContainer) => container.Names?.[0]?.replace(/^\//, '') || container.Id.slice(0, 12)

const rowOf = (container: DockerContainer): ContainerRow => ({
    name: idOf(container),
    image: container.Image,
    state: container.State,
    status: container.Status,
    created: container.Created,
    // Flattened to a string on purpose: a port list is something a person reads on a row, and a
    // nested array would draw as a branch in a grid that is meant to be one line per container.
    ports: (container.Ports ?? [])
        .filter((port) => port.PublicPort !== undefined)
        .map((port) => `${port.PublicPort}→${port.PrivatePort}/${port.Type}`)
        .join(' ')
})
