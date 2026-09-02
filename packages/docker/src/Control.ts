import { request } from 'node:http'
import { componentSnapshot, rpc, rpcNamespace, RpcComponent, type RpcDataResource, type RpcInvocationHandle } from '@source-repo/rpc'
import { DockerEngine, type DockerContainer, type DockerEngineOptions } from './Engine.js'

/**
 * Changing a container that already exists: start, stop, restart, remove.
 *
 * **A separate class in a separate namespace, and that is the point rather than tidiness.** Two
 * namespaces are two `authorize()` surfaces, so an operator can grant reading to everyone and
 * control to nobody. A subclass would have made "may call docker" one permission, and would have
 * made the read-only class's promise a lie by inheritance - code holding a `DockerService` could
 * be holding a control one.
 *
 * **Why this tier is defensible where creating is not.** Restarting a container that already exists
 * escalates nothing: its image, its mounts and its privileges were decided by whoever created it,
 * and none of them change here. Creating a *new* one is where a caller chooses those, which is the
 * tier that needs an image allow-list and a spec that cannot express an escape - see `Create.ts`.
 * Collapsing the two is what makes "the Docker socket is root on the host" sound like the whole
 * story when it is only true of the half above this one.
 *
 * **Closed by default.** With no `manage` rule, nothing is controllable and every call is refused.
 * That is deliberate: a node exposed by accident should be able to do nothing at all, and an
 * allow-list somebody has to remember to add is one they will remember when it refuses them.
 */

/** Which containers this node may act on. Nothing matches an empty list, which is the default. */
export interface DockerManageRule {
    /** Names beginning with this. The ordinary way to fence a node to its own containers. */
    namePrefix?: string
    /** A label that must be present, and its value where one is given. */
    label?: { name: string; value?: string }
}

export interface DockerControlOptions extends DockerEngineOptions {
    manage?: readonly DockerManageRule[]
}

/**
 * The write half of the Engine API, kept out of `DockerEngine` on purpose.
 *
 * `DockerEngine` has one method and it issues `GET`. That is a promise a reader can check in ten
 * seconds, and it stays true only if nothing ever adds a `method` parameter to it - which is
 * exactly what the next person needing to restart something would have done. So the verbs that
 * change things live here, in the file whose name says so.
 */
export class DockerWriteEngine {
    constructor(
        readonly socketPath: string,
        private readonly timeoutMs: number
    ) {}

    act(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
        return new Promise<unknown>((resolve, reject) => {
            const headers = payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : undefined
            const call = request({ socketPath: this.socketPath, path, method, timeout: this.timeoutMs, ...(headers ? { headers } : {}) }, (response) => {
                const chunks: Buffer[] = []
                response.on('data', (chunk: Buffer) => chunks.push(chunk))
                response.on('end', () => {
                    const status = response.statusCode ?? 0
                    if (status >= 400) {
                        const body = Buffer.concat(chunks).toString('utf8')
                        let said = body
                        try {
                            said = (JSON.parse(body) as { message?: string }).message ?? body
                        } catch {
                            // Not JSON; the body is the best there is to report.
                        }
                        reject(new Error(`docker ${method} ${path} answered ${status}: ${said}`))
                        return
                    }
                    const body = Buffer.concat(chunks).toString('utf8')
                    try {
                        resolve(body ? JSON.parse(body) : undefined)
                    } catch {
                        // A verb that answers a progress stream rather than JSON - `pull` does -
                        // has already succeeded by the time the body ends, and the body is not
                        // what the caller asked about.
                        resolve(undefined)
                    }
                })
            })
            call.on('timeout', () => call.destroy(new Error(`docker ${method} ${path} did not answer within ${this.timeoutMs} ms`)))
            call.on('error', (e: NodeJS.ErrnoException) =>
                reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? new Error(`no Docker daemon at ${this.socketPath}`) : e)
            )
            // The body goes with the end, which is the whole of it - setting content-length and
            // then sending nothing leaves the daemon waiting for bytes that never arrive, and it
            // surfaces as a timeout rather than as anything that names the cause.
            call.end(payload)
        })
    }
}

@rpcNamespace('docker.control', { version: '1' })
export class DockerControl extends RpcComponent<{ socketPath: string; manages: number }, { lastAction?: string; lastAt: number }> {
    private readonly engine: DockerEngine
    private readonly write: DockerWriteEngine
    private readonly manage: readonly DockerManageRule[]

    constructor(options: DockerControlOptions = {}) {
        const engine = new DockerEngine(options)
        super({ socketPath: engine.socketPath, manages: options.manage?.length ?? 0 }, { lastAt: 0 })
        this.engine = engine
        // Longer than a read on purpose. `stop` is a graceful shutdown: the daemon sends SIGTERM
        // and waits its own grace period - ten seconds by default - before SIGKILL, so a five
        // second client timeout is shorter than the operation's own contract and gives up on a
        // container that was going to stop perfectly well. A process that is PID 1 with no signal
        // handler, which is most `CMD` lines, always takes the full grace.
        this.write = new DockerWriteEngine(engine.socketPath, options.timeoutMs ?? 30_000)
        // A rule constraining nothing would match everything, which is the opposite of what an
        // allow-list is for. Refused where it was written rather than quietly matching nothing:
        // silently matching nothing is just as wrong and is discovered much later, by somebody
        // wondering why their perfectly good rule does not work.
        for (const rule of options.manage ?? [])
            if (!rule.namePrefix && !rule.label)
                throw new Error('DockerControl: a manage rule must name a namePrefix or a label; one that constrains nothing would match everything')
        this.manage = options.manage ?? []
    }

    /**
     * Composing this in is what makes a host able to change containers, so composing it in is what
     * says so. Nothing to remember, which matters because forgetting is the failure this catches.
     */
    elevation() {
        if (!this.manage.length) return undefined
        return {
            capability: 'docker.control',
            reason: `may start, stop and remove containers matching ${this.manage.map((rule) => rule.namePrefix ?? `label ${rule.label?.name}`).join(', ')}`
        }
    }

    /**
     * The containers this node may act on, and only those.
     *
     * The same list the read-only node serves, narrowed - so a console pointed at this namespace
     * shows exactly what it can do something about, rather than showing everything and refusing
     * most of it when somebody presses a button.
     */
    dataResources(): readonly RpcDataResource[] {
        return [
            {
                path: ['managed'],
                label: 'Managed containers',
                verbs: ['getList', 'getMany'],
                // `remove` asks first, and what it asks has to name the container somebody meant
                // rather than the id the row is keyed by.
                presentation: { representation: 'name' },
                row: {
                    kind: 'object',
                    fields: { name: { type: { kind: 'string' } }, image: { type: { kind: 'string' } }, state: { type: { kind: 'string' } }, status: { type: { kind: 'string' } } }
                },
                // Declared methods, so authorize() rules on each and the console offers exactly
                // these. `remove` asks first because it is the one that does not come back.
                actions: [
                    { method: 'start', label: 'start' },
                    { method: 'stop', label: 'stop' },
                    { method: 'restart', label: 'restart' },
                    { method: 'remove', label: 'remove', confirm: true }
                ]
            }
        ]
    }

    async dataRequest(method: string, _resource: readonly string[], params: unknown) {
        const { pageEntries } = await import('@source-repo/rpc')
        const entries = (await this.managed()).map((one) => [nameOf(one), { name: nameOf(one), image: one.Image, state: one.State, status: one.Status }] as const)
        const snapshot = componentSnapshot(this)
        if (method === 'getMany') {
            const wanted = new Set((params as { ids: string[] }).ids)
            const found = entries.filter(([id]) => wanted.has(id))
            return { ids: found.map(([id]) => id), data: found.map(([, row]) => row), epoch: snapshot.epoch, revision: snapshot.revision }
        }
        return { ...pageEntries(entries, params as never), epoch: snapshot.epoch, revision: snapshot.revision }
    }

    @rpc({ semantics: 'idempotent-command' })
    async start(name: string, inv?: RpcInvocationHandle) {
        return this.perform('start', name, inv)
    }

    @rpc({ semantics: 'idempotent-command' })
    async stop(name: string, inv?: RpcInvocationHandle) {
        return this.perform('stop', name, inv)
    }

    @rpc({ semantics: 'idempotent-command' })
    async restart(name: string, inv?: RpcInvocationHandle) {
        return this.perform('restart', name, inv)
    }

    /** Removes the container, not its image or its volumes. Force-stops first, as `docker rm -f` does. */
    @rpc({ semantics: 'idempotent-command' })
    async remove(name: string, inv?: RpcInvocationHandle) {
        return this.perform('remove', name, inv)
    }

    /**
     * Every action goes through here, so the allow-list cannot be forgotten on one of four methods.
     *
     * Checked against the container as the daemon reports it *now*, rather than against the name the
     * caller sent: a name is a claim and a label is a fact, and a rule written about labels would
     * otherwise be satisfied by anybody who could guess a name.
     */
    private async perform(action: 'start' | 'stop' | 'restart' | 'remove', name: string, inv?: RpcInvocationHandle) {
        const allowed = (await this.managed()).find((one) => nameOf(one) === name)
        if (!allowed)
            throw new Error(
                this.manage.length
                    ? `${name} is not a container this node manages`
                    : `${name} is not managed: this node was given no manage rules, so it controls nothing`
            )
        const path = action === 'remove' ? `/containers/${allowed.Id}?force=true` : `/containers/${allowed.Id}/${action}`
        await this.write.act(action === 'remove' ? 'DELETE' : 'POST', path)
        this.setState({ lastAction: `${action} ${name}${inv ? ` by ${inv.context.source}` : ''}`, lastAt: Date.now() })
        return 'ok' as const
    }

    /** Containers matching a manage rule. An empty rule list matches nothing, deliberately. */
    private async managed(): Promise<DockerContainer[]> {
        if (!this.manage.length) return []
        const containers = await this.engine.containers()
        return containers.filter((one) => this.manage.some((rule) => matches(rule, one)))
    }
}

const nameOf = (container: DockerContainer) => container.Names?.[0]?.replace(/^\//, '') || container.Id.slice(0, 12)

const matches = (rule: DockerManageRule, container: DockerContainer) => {
    if (rule.namePrefix && !nameOf(container).startsWith(rule.namePrefix)) return false
    if (rule.label) {
        const held = container.Labels?.[rule.label.name]
        if (held === undefined) return false
        if (rule.label.value !== undefined && held !== rule.label.value) return false
    }
    return true
}
