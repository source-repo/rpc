import { request } from 'node:http'

/**
 * The Docker Engine API, over the socket, with nothing between.
 *
 * No client library, and no dependency: Node's own `http.request` takes a `socketPath`, which is
 * all talking to `/var/run/docker.sock` has ever required. A dependency here would be a dependency
 * a plant node carries forever for the sake of a dozen lines.
 *
 * **Read-only by construction, which is the whole design of this package.** There is one method and
 * it issues `GET`. Write access to the Docker socket is not "a bit more permission" - it is root on
 * the host, with no namespace to bound it to and no RBAC above it: a caller able to create a
 * container can mount `/` and own the machine. That is a product with a support contract attached,
 * and it is deliberately not this. See the README.
 */
export interface DockerEngineOptions {
    /** Where the daemon listens. The default is where it listens on every ordinary Linux host. */
    socketPath?: string
    /** How long to wait for the daemon, which is local and therefore fast or broken. */
    timeoutMs?: number
}

export const DEFAULT_SOCKET = '/var/run/docker.sock'
export const DEFAULT_TIMEOUT = 5_000

export class DockerEngine {
    readonly socketPath: string
    private readonly timeoutMs: number

    constructor(options: DockerEngineOptions = {}) {
        this.socketPath = options.socketPath ?? DEFAULT_SOCKET
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT
    }

    /**
     * One GET against the daemon.
     *
     * Private and `GET`-only rather than a general `call(method, path)`, because a general one is
     * how the read-only promise above stops being true: the next person needing to restart a
     * container adds a `method` parameter, and the package quietly becomes the other product.
     */
    private get<T>(path: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const call = request({ socketPath: this.socketPath, path, method: 'GET', timeout: this.timeoutMs }, (response) => {
                const chunks: Buffer[] = []
                response.on('data', (chunk: Buffer) => chunks.push(chunk))
                response.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8')
                    // The daemon answers errors as JSON with a message, which is worth more to
                    // whoever is reading than the status code on its own.
                    if ((response.statusCode ?? 0) >= 400) {
                        let said = body
                        try {
                            said = (JSON.parse(body) as { message?: string }).message ?? body
                        } catch {
                            // Not JSON, so the body is the best thing there is to report.
                        }
                        reject(new Error(`docker ${path} answered ${response.statusCode}: ${said}`))
                        return
                    }
                    try {
                        resolve(JSON.parse(body) as T)
                    } catch (e) {
                        reject(new Error(`docker ${path} answered something that is not JSON: ${(e as Error).message}`))
                    }
                })
            })
            call.on('timeout', () => call.destroy(new Error(`docker ${path} did not answer within ${this.timeoutMs} ms`)))
            // The daemon being absent is the ordinary case on a machine without Docker, and it
            // should read as that rather than as a stack trace about a missing file.
            call.on('error', (e: NodeJS.ErrnoException) =>
                reject(
                    e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
                        ? new Error(`no Docker daemon at ${this.socketPath} - is Docker running, and is this process allowed to reach its socket?`)
                        : e
                )
            )
            call.end()
        })
    }

    /** Whether the daemon is there and answering, and what it is. */
    async version(): Promise<{ Version: string; ApiVersion: string }> {
        return this.get('/version')
    }

    /** Every container, running or not - `all=1`, because a stopped one is usually the interesting one. */
    async containers(): Promise<DockerContainer[]> {
        return this.get('/containers/json?all=1')
    }

    /** Whether an image is present locally, which is what decides if a test can run without a pull. */
    async inspectImage(image: string): Promise<{ Id: string }> {
        return this.get(`/images/${encodeURIComponent(image)}/json`)
    }

    /** What the daemon says about one container, for the fields the list does not carry. */
    async inspect(id: string): Promise<DockerInspect> {
        return this.get(`/containers/${encodeURIComponent(id)}/json`)
    }
}

/** The fields of `/containers/json` this package reads. The daemon sends a great many more. */
export interface DockerContainer {
    Id: string
    Names: string[]
    Image: string
    ImageID: string
    Command: string
    Created: number
    State: string
    Status: string
    Labels?: Record<string, string>
    Ports?: { PrivatePort: number; PublicPort?: number; Type: string }[]
}

export interface DockerInspect {
    Id: string
    Name: string
    State: { Status: string; Running: boolean; StartedAt: string; FinishedAt: string; ExitCode: number; Health?: { Status: string } }
    Config: { Image: string; Labels?: Record<string, string> }
}
