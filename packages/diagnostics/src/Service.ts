import { digestText, rpc, RpcComponent, rpcNamespace, type ExposeOptions } from '@source-repo/rpc'
import { readFileSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { bindingsOf, capabilitiesFor, type RpcActiveSourceIdentity, type RpcDiagnosticsCapabilities, type RpcDiagnosticsSupport, type RpcSourceBinding, type RpcSourceCatalogue } from './Catalogue.js'

/**
 * What this node will let somebody see of its own source, and where its values are written down.
 *
 * **A component, because the design says so in the shape of its own contract.** The illustrative
 * `NodeDiagnostics` has `capabilities` and `activeSource` as readonly *properties*, and a readonly
 * property that a viewer watches is what an observable component already is here - so they are
 * props, a viewer subscribes, and a redeploy that changes the running revision reaches every open
 * editor without anybody polling for it.
 *
 * **It serves metadata and never values.** The values a viewer draws come from the component channel
 * it already has, through the permission check that was always there. There is no second data path,
 * which is why there is no second data path to secure.
 */

export interface RpcDiagnosticsProps extends RpcDiagnosticsCapabilities {
    /** Which revision each component is running, so a viewer can refuse to overlay a stale file. */
    readonly components: { readonly [componentType: string]: RpcActiveSourceIdentity }
    [key: string]: unknown
}

export interface RpcDiagnosticsState {
    /** Source files handed out. A count rather than a log: who asked is the audit layer's business. */
    sourceReads: number
    /** Requests refused for naming a file this node does not serve, or serves and may not disclose. */
    refusals: number
    [key: string]: unknown
}

export interface RpcDiagnosticsOptions {
    /** What the build produced. Without one this node advertises no source linking at all. */
    readonly catalogue: RpcSourceCatalogue
    /**
     * Where the files in the catalogue live, so `source()` can read them.
     *
     * Omit it and the node serves bindings and identity but no text, advertising
     * `sourceAvailable: false`. That is the right default for a plant: a binding catalogue says
     * where a value is declared, and the source itself is a different disclosure with a different
     * audience - a viewer that has its own checkout needs only the first.
     */
    readonly sourceRoot?: string
    /** The activation this process is. Changes on restart, which is exactly what it is for. */
    readonly activationEpoch?: string
    /**
     * What else this deployment has wired: variant activation, a probe sink and its bounds.
     *
     * Passed in rather than detected, because both are facts about the host. A node has variant
     * activation when somebody gave it an ownership store, fences and a coordinator; two nodes
     * running this same package can honestly answer differently, and a package that guessed would
     * advertise a capability the deployment never arranged for.
     */
    readonly support?: Omit<RpcDiagnosticsSupport, 'sourceAvailable'>
}

@rpcNamespace('diagnostics')
export class RpcDiagnostics extends RpcComponent<RpcDiagnosticsProps, RpcDiagnosticsState> {
    private readonly catalogue_: RpcSourceCatalogue
    private readonly sourceRoot?: string

    constructor(options: RpcDiagnosticsOptions) {
        const sourceRoot = options.sourceRoot ? resolve(options.sourceRoot) : undefined
        const epoch = options.activationEpoch ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
        super(
            {
                ...capabilitiesFor({ ...options.support, sourceAvailable: sourceRoot !== undefined }),
                components: Object.fromEntries(
                    Object.keys(options.catalogue.components).map((componentType) => [
                        componentType,
                        {
                            componentType,
                            semanticRevisionId: options.catalogue.semanticRevisionId,
                            sourceBundleHash: options.catalogue.sourceBundleHash,
                            activationEpoch: epoch
                        }
                    ])
                )
            },
            { sourceReads: 0, refusals: 0 }
        )
        this.catalogue_ = options.catalogue
        this.sourceRoot = sourceRoot
    }

    /**
     * Where one component's props and state are declared.
     *
     * A query, and cheap: this is static metadata computed at build time. It carries no values, so
     * it is not a way around whatever `authorize()` decides about the component itself - what it
     * discloses is the shape of the source, which is the same thing the contract already publishes
     * with line numbers attached.
     */
    @rpc({ semantics: 'query', effect: 'observe' })
    async bindings(componentType: string): Promise<readonly RpcSourceBinding[]> {
        return bindingsOf(this.catalogue_, componentType)
    }

    /**
     * The whole catalogue: the revision, the bundle hash, and the files it was built from.
     *
     * Asked for rather than carried by the viewer, and that is the point of it being a call. A
     * viewer holding a catalogue from a previous deploy is exactly the case the revision comparison
     * exists to catch, and it can only catch it if the catalogue it compares against came from the
     * node that is running now.
     *
     * Still no values: file names, hashes and positions. What it discloses is the shape of the
     * source, which the contract already publishes without the line numbers.
     */
    @rpc({ semantics: 'query', effect: 'observe' })
    async catalogue(): Promise<RpcSourceCatalogue> {
        return this.catalogue_
    }

    /** Which revision a component is running. Also in props; here for a caller that is not watching. */
    @rpc({ semantics: 'query', effect: 'observe' })
    async activeSource(componentType: string): Promise<RpcActiveSourceIdentity | undefined> {
        return this.props.components[componentType]
    }

    /**
     * The text of one file this build was made from, with the hash it had when it was.
     *
     * **A separate permission from everything else here**, which is why it is a separate method: a
     * viewer may legitimately be allowed to know that `state.setpoint` is declared at line 34 and
     * not be allowed to read the file that says so. `authorize()` sees the method name and the file
     * being asked for.
     *
     * Only files the catalogue names, resolved against the configured root and checked to stay
     * under it - a file id arrives from the network, and `../../etc/shadow` is the shape of what
     * happens to a path that is merely joined.
     */
    @rpc({ semantics: 'query', effect: 'observe' })
    async source(fileId: string): Promise<{ readonly fileId: string; readonly text: string; readonly contentHash: string }> {
        if (!this.sourceRoot) {
            this.setState((previous) => ({ refusals: previous.refusals + 1 }))
            throw new Error('this node serves no source: it advertises where values are declared, and reading the files is a disclosure it was not configured for')
        }
        const known = this.catalogue_.files.find((file) => file.fileId === fileId)
        if (!known) {
            this.setState((previous) => ({ refusals: previous.refusals + 1 }))
            throw new Error(`${fileId} is not a file this build was made from`)
        }
        const path = resolve(join(this.sourceRoot, normalize(known.fileId)))
        const inside = relative(this.sourceRoot, path)
        if (inside.startsWith('..') || isAbsolute(inside)) {
            // Unreachable through a catalogue this node built, and checked anyway: the id arrived
            // over a network, and a path that is merely joined is how a traversal happens.
            this.setState((previous) => ({ refusals: previous.refusals + 1 }))
            throw new Error(`${fileId} resolves outside the configured source root`)
        }
        const text = readFileSync(path, 'utf8')
        const contentHash = await digestText(text)
        this.setState((previous) => ({ sourceReads: previous.sourceReads + 1 }))
        // The hash of what was *read*, not what the catalogue recorded. A file edited on the node
        // since the build has to be visible as such rather than silently served under the old hash.
        return { fileId: known.fileId, text, contentHash }
    }
}

/**
 * Stand diagnostics up on a server.
 *
 * `parallel`, because reading a file must not hold the node against every other caller - and because
 * nothing here mutates anything a second caller could observe half-done.
 */
export const exposeDiagnostics = (
    server: { exposeClassInstance(instance: object, name?: string, options?: ExposeOptions): unknown },
    options: RpcDiagnosticsOptions,
    name = 'diagnostics'
): RpcDiagnostics => {
    const service = new RpcDiagnostics(options)
    server.exposeClassInstance(service, name, { execution: 'parallel' })
    return service
}
