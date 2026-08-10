import { componentSnapshot, rpc, rpcNamespace, RpcComponent, type RpcInvocationHandle } from '@source-repo/rpc'
import { DockerWriteEngine } from './Control.js'
import { DockerEngine, type DockerEngineOptions } from './Engine.js'

/**
 * Making containers, which is a development capability and is separated as one.
 *
 * This is the tier where "the Docker socket is root on the host" is actually true, and it is true
 * for a specific reason: a caller who chooses the image *and* the mounts *and* the privileges can
 * mount `/` and own the machine. Every part of that sentence matters, because the escape is in the
 * mounts and the privileges rather than in the act of creating something.
 *
 * **So the spec cannot express one.** `RunSpec` below has no bind mounts, no `privileged`, no added
 * capabilities, no devices, no host network and no host PID namespace, and it is a closed shape
 * rather than a passthrough with a deny-list. That is the same move the filter grammar makes: ship
 * a vocabulary rather than an evaluator, because a deny-list is a list somebody has to keep
 * complete and a closed shape is one nobody can add to from the outside.
 *
 * What remains is roughly "run this allow-listed image with this configuration", which is about as
 * dangerous as the image itself - which is what the allow-list is for.
 *
 * **Separated three ways, on purpose.** Its own class, so it is composed rather than inherited; its
 * own namespace `docker.create`, so it is a distinct `authorize()` surface an operator can withhold
 * while granting the others; and its own subpath export, so importing it is a visible line in a
 * diff rather than an option somebody set.
 *
 * **Closed by default.** With no `images` allow-list nothing can be created, and the refusal says
 * so rather than reporting a daemon error.
 */

/** What may be created. An empty list permits nothing, which is the default. */
export interface DockerImageRule {
    /** A repository, with an optional trailing `*`: `postgres`, `emqx/emqx`, `ghcr.io/acme/*`. */
    repository: string
}

export interface DockerCreateOptions extends DockerEngineOptions {
    images?: readonly DockerImageRule[]
    /**
     * Every container this node makes gets a name beginning with this, and is labelled as its work.
     *
     * Two jobs. It stops a created container colliding with something that was already there, and
     * it makes what this node made identifiable afterwards - so a `DockerControl` fenced to the
     * same prefix can stop and remove exactly the things this created and nothing else.
     */
    namePrefix?: string
}

/**
 * What a caller may ask for. Everything a container escape needs is absent, and absent by shape.
 *
 * Note what is *not* here: `Binds`, `Mounts`, `Privileged`, `CapAdd`, `Devices`, `NetworkMode`,
 * `PidMode`, `IpcMode`, `UsernsMode`. A caller cannot ask for them because there is nowhere to put
 * them, which is a stronger guarantee than a check that has to be maintained.
 */
export interface RunSpec {
    /** The image, which must match an allow-list rule. */
    image: string
    /** Appended to the node's prefix. Letters, digits, dash and underscore only. */
    name: string
    env?: Record<string, string>
    /** Container port to host port. Bound to loopback, because a development node should not publish. */
    ports?: Record<number, number>
    labels?: Record<string, string>
    /** Command arguments, where the image needs them. Not a shell - an argument list. */
    args?: string[]
}

export const CREATED_BY_LABEL = 'source-rpc.created-by'

@rpcNamespace('docker.create', { version: '1' })
export class DockerCreate extends RpcComponent<{ socketPath: string; namePrefix: string; images: number }, { created: number; lastAt: number }> {
    private readonly engine: DockerEngine
    private readonly write: DockerWriteEngine
    private readonly images: readonly DockerImageRule[]
    private readonly prefix: string

    constructor(options: DockerCreateOptions = {}) {
        const engine = new DockerEngine(options)
        const prefix = options.namePrefix ?? 'source-'
        super({ socketPath: engine.socketPath, namePrefix: prefix, images: options.images?.length ?? 0 }, { created: 0, lastAt: 0 })
        this.engine = engine
        this.write = new DockerWriteEngine(engine.socketPath, options.timeoutMs ?? 30_000)
        this.images = options.images ?? []
        this.prefix = prefix
    }

    /** Composing this in is what says so - see DockerControl.elevation for why it is not declared. */
    elevation() {
        if (!this.images.length) return undefined
        return { capability: 'docker.create', reason: `may create containers from ${this.images.map((rule) => rule.repository).join(', ')}` }
    }

    /** What this node is permitted to run, so a caller can find out before being refused. */
    @rpc({ semantics: 'query' })
    async allowed(): Promise<string[]> {
        return this.images.map((rule) => rule.repository)
    }

    /** Fetch an allow-listed image. Slow, and worth doing before `run` rather than inside it. */
    @rpc({ semantics: 'idempotent-command' })
    async pull(image: string) {
        this.permit(image)
        await this.write.act('POST', `/images/create?fromImage=${encodeURIComponent(image)}`)
        return 'ok' as const
    }

    /**
     * Create a container from an allow-listed image and start it.
     *
     * Not idempotent, and declared so: two calls make two containers, and a retry after an
     * uncertain answer would make a second one. A caller that needs at-most-once behaviour names
     * the container and checks for it, or sends an idempotency key.
     */
    @rpc({ semantics: 'non-repeatable-command' })
    async run(spec: RunSpec, inv?: RpcInvocationHandle): Promise<{ name: string }> {
        this.permit(spec.image)
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(spec.name))
            throw new Error(`${spec.name} is not a usable container name: letters, digits, dash and underscore, starting with a letter or digit`)
        const name = `${this.prefix}${spec.name}`

        const created = (await this.write.act('POST', `/containers/create?name=${encodeURIComponent(name)}`, {
            Image: spec.image,
            ...(spec.args?.length ? { Cmd: spec.args } : {}),
            ...(spec.env ? { Env: Object.entries(spec.env).map(([key, value]) => `${key}=${value}`) } : {}),
            Labels: {
                ...(spec.labels ?? {}),
                // Stamped rather than optional: what this node made must be findable afterwards,
                // both to clean up and to answer "where did that come from" six months later.
                [CREATED_BY_LABEL]: inv?.context.source ?? 'unknown'
            },
            HostConfig: {
                // Bound to loopback deliberately. A development node publishing a port on every
                // interface is how a test database ends up reachable from the site network.
                ...(spec.ports
                    ? {
                          PortBindings: Object.fromEntries(
                              Object.entries(spec.ports).map(([inside, outside]) => [`${inside}/tcp`, [{ HostIp: '127.0.0.1', HostPort: String(outside) }]])
                          )
                      }
                    : {}),
                // Said explicitly rather than left to the daemon's defaults, so that reading this
                // file tells you what a created container can do without knowing Docker's defaults.
                Privileged: false,
                NetworkMode: 'bridge',
                CapAdd: [],
                Binds: []
            }
        })) as { Id: string }

        await this.write.act('POST', `/containers/${created.Id}/start`)
        this.setState({ created: this.state.created + 1, lastAt: Date.now() })
        return { name }
    }

    /** Whether an image is allowed, refusing with the list rather than with a daemon error. */
    private permit(image: string) {
        const repository = image.split('@')[0].replace(/:[^:/]*$/, '')
        const ok = this.images.some((rule) =>
            rule.repository.endsWith('*') ? repository.startsWith(rule.repository.slice(0, -1)) : repository === rule.repository
        )
        if (!ok)
            throw new Error(
                this.images.length
                    ? `${image} is not on this node's image allow-list (${this.images.map((rule) => rule.repository).join(', ')})`
                    : `${image} is refused: this node was given no image allow-list, so it can create nothing`
            )
    }

    /** Where an answer came from, so a caller can tell a restart from an update. */
    stamp() {
        const snapshot = componentSnapshot(this)
        return { epoch: snapshot.epoch, revision: snapshot.revision }
    }

    /** What this node has made, by the label it stamps on everything. */
    @rpc({ semantics: 'query' })
    async mine(): Promise<string[]> {
        const containers = await this.engine.containers()
        return containers.filter((one) => one.Labels?.[CREATED_BY_LABEL] !== undefined).map((one) => one.Names?.[0]?.replace(/^\//, '') ?? one.Id.slice(0, 12))
    }
}
