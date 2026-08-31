/**
 * A rack of serial ports: the case a tree of everything serves badly.
 *
 * This exists to be pointed a console at, and it is deliberately **not** an aspect provider. The
 * question it answers is whether a detail view is general - whether an ordinary component with a
 * data resource can have one - and if it needed `@source-repo/aspects` to get there it would be
 * answering the opposite. So it is an `RpcComponent` with one resource, `getChildren` and `getOne`,
 * and nothing else: the smallest thing that can have the problem.
 *
 * ## The shape
 *
 * Cabinets hold hubs and hubs hold ports. The branches are **scope and nothing else**: nobody
 * compares two cabinets, they pick one. The ports under a hub are the opposite - the same five
 * fields as each other, and reading the error count *down* the column is the whole job.
 *
 * That is the arrangement a document library does not want. A handbook's leaf *is* its content and
 * its siblings have nothing worth aligning, so a tree with the documents in it is right there and
 * a table of titles would be four columns of noise. Here it is the other way round. Same verb, same
 * console, opposite priorities - which is why the console cannot pick one arrangement for both.
 *
 * ## One row type, two answers
 *
 * `row` describes every row this resource hands out - cabinets, hubs and ports alike - so the
 * fields only a port has are optional, and so are the fifteen that only `getOne` populates. A list
 * says what a port looks like *among its siblings*; `getOne` says what it looks like *on its own*,
 * which here is twenty-two fields no table has room for. Both are governed by the one declared type
 * a caller can read, which is the arrangement the contract intends rather than a trick.
 *
 * `description` is in the row type and **not** in `defaultColumns`. That is the distinction the hint
 * exists to make: it is a sentence, and a sentence in a column pushes four useful numbers off the
 * screen. Every field stays selectable; this only decides what is shown first.
 *
 * Note that `row` is written out as a value rather than derived from the `PortRow` interface below.
 * Props and state are read from their interfaces by `extract`, because they are the component's own
 * shape and are known at compile time; a resource's rows may come from a database whose columns are
 * known only when the node connects to it, so the declaration is made at runtime. This example
 * happens to know both, and says so twice - which `validateResults` below then checks.
 *
 * Run it with the decorator-free twin, which is what `strip` is for:
 *
 *     npm run example:serial-ports:contract   # extract -> contract.json, the published interface
 *     npm run example:serial-ports:build      # strip   -> dist/plant.ts, which Node runs directly
 *     node examples/serial-ports/dist/plant.ts
 */

import { readFile } from 'node:fs/promises'
import { RpcComponent, RpcServer, rpc, rpcNamespace } from '@source-repo/rpc'
import type { RpcDataMethod, RpcDataResource, RpcGetChildrenParams, RpcGetChildrenResult, RpcGetOneParams, RpcGetOneResult, RpcResource } from '@source-repo/rpc'

const NAME = process.env.PLANT_NAME ?? 'edge-gw-1'
const PORT = Number(process.env.PLANT_PORT ?? 7845)
/**
 * A hub to join instead of a port to listen on.
 *
 * Here because an example is most useful beside the others: `HUB=http://localhost:3992` puts this
 * rack in a console that is already showing a plant, rather than needing a console of its own.
 */
const HUB = process.env.HUB
const contract = JSON.parse(await readFile(new URL('../contract.json', import.meta.url), 'utf8'))

// --------------------------------------------------------------------------- what the rack holds

/**
 * Type aliases rather than interfaces, and it has to be that way round.
 *
 * `RpcComponent<P, S>` constrains both to `RpcComponentData`, which is `Record<string, unknown>` -
 * and TypeScript gives an object *type alias* an implicit index signature while an `interface` gets
 * none, so an otherwise identical interface does not satisfy the constraint. Only the two handed to
 * `RpcComponent` need it; the row shapes below stay interfaces.
 */
type RackProps = {
    /** The gateway this rack is wired to. */
    readonly host: string
    /** The udev rules version, because somebody always asks. */
    readonly udev: string
}

type RackState = {
    readonly open: number
    readonly faulted: number
    /** Every error on every port, which is the number worth watching from across a room. */
    readonly errors: number
}

/** What a *list* carries: the columns, and none of the fifteen fields behind them. */
interface PortRow {
    id: string
    title: string
    node: 'port'
    port: string
    baudrate: number
    status: 'open' | 'closed' | 'fault'
    errors: number
    description: string
}

/** What `getOne` adds. Nobody wants these in a table and everybody wants them when chasing a fault. */
interface PortDetail extends PortRow {
    parity: string
    dataBits: number
    stopBits: number
    flowControl: string
    driver: string
    devicePath: string
    framingErrors: number
    parityErrors: number
    overruns: number
    bytesIn: number
    bytesOut: number
    openedAt: string
    lastError: string
    connectedTo: string
}

/** A branch as a row: no port fields at all, which is why the declared type has them optional. */
interface BranchRow {
    id: string
    title: string
    node: 'cabinet' | 'hub'
    location: string
}

// --------------------------------------------------------------------------- the fixture

const port = (
    id: string,
    device: string,
    baudrate: number,
    status: PortRow['status'],
    errors: number,
    description: string,
    rest: Partial<PortDetail>
): PortDetail => ({
    id,
    title: device,
    node: 'port',
    port: device,
    baudrate,
    status,
    errors,
    description,
    parity: 'none',
    dataBits: 8,
    stopBits: 1,
    flowControl: 'none',
    driver: 'ftdi_sio',
    devicePath: '',
    framingErrors: 0,
    parityErrors: 0,
    overruns: 0,
    bytesIn: 0,
    bytesOut: 0,
    openedAt: '',
    lastError: '',
    connectedTo: '',
    ...rest
})

const ports: { [id: string]: PortDetail } = {
    'usb-0': port('usb-0', '/dev/ttyUSB0', 115200, 'open', 0, 'Filler line 1 weigh cell, Modbus RTU', {
        devicePath: '/sys/bus/usb/devices/1-1.2',
        bytesIn: 4192338,
        bytesOut: 210044,
        openedAt: '06:02:11',
        connectedTo: 'WEIGH-01'
    }),
    'usb-1': port('usb-1', '/dev/ttyUSB1', 9600, 'fault', 417, 'Capper torque head — intermittent since the cable was reseated', {
        parity: 'even',
        flowControl: 'rts/cts',
        devicePath: '/sys/bus/usb/devices/1-1.3',
        framingErrors: 402,
        overruns: 15,
        bytesIn: 88231,
        bytesOut: 12004,
        openedAt: '06:02:11',
        lastError: 'framing error at 09:41:07',
        connectedTo: 'CAP-02'
    }),
    'usb-2': port('usb-2', '/dev/ttyUSB2', 19200, 'open', 3, 'Labeller print engine', {
        flowControl: 'xon/xoff',
        driver: 'cp210x',
        devicePath: '/sys/bus/usb/devices/1-1.4',
        framingErrors: 3,
        bytesIn: 902114,
        bytesOut: 774031,
        openedAt: '06:02:12',
        lastError: 'framing error at 07:18:44',
        connectedTo: 'LABEL-01'
    }),
    'usb-3': port('usb-3', '/dev/ttyUSB3', 0, 'closed', 0, 'Spare', { devicePath: '/sys/bus/usb/devices/1-1.5' }),
    'usb-4': port('usb-4', '/dev/ttyUSB4', 38400, 'open', 0, 'Palletiser handshake', {
        driver: 'ch341',
        devicePath: '/sys/bus/usb/devices/1-2.1',
        bytesIn: 331882,
        bytesOut: 190044,
        openedAt: '06:02:12',
        connectedTo: 'PAL-01'
    }),
    'usb-5': port('usb-5', '/dev/ttyUSB5', 57600, 'open', 12, 'Vision system serial trigger', {
        stopBits: 2,
        driver: 'ch341',
        devicePath: '/sys/bus/usb/devices/1-2.2',
        parityErrors: 12,
        bytesIn: 55021,
        bytesOut: 55021,
        openedAt: '06:02:12',
        lastError: 'parity error at 08:55:02',
        connectedTo: 'VIS-01'
    }),
    's-0': port('s-0', '/dev/ttyS0', 9600, 'open', 0, 'Console, onboard UART', {
        driver: '8250',
        devicePath: '/sys/devices/platform/serial8250',
        bytesIn: 1204,
        bytesOut: 88110,
        openedAt: '06:02:10'
    }),
    's-1': port('s-1', '/dev/ttyS1', 0, 'closed', 0, 'Spare, onboard UART', { driver: '8250', devicePath: '/sys/devices/platform/serial8250' })
}

/** The branches. A cabinet holds hubs; a hub holds ports, named by id. */
const branches: { [id: string]: BranchRow & { children?: string[]; ports?: string[] } } = {
    'cab-a': { id: 'cab-a', title: 'Cabinet A', node: 'cabinet', location: 'Hall 2, north wall', children: ['cab-a/hub-1', 'cab-a/hub-2'] },
    'cab-b': { id: 'cab-b', title: 'Cabinet B', node: 'cabinet', location: 'Hall 2, by the palletiser', children: ['cab-b/onboard'] },
    'cab-a/hub-1': { id: 'cab-a/hub-1', title: 'USB hub 1', node: 'hub', location: 'Cabinet A, DIN rail 1', ports: ['usb-0', 'usb-1', 'usb-2', 'usb-3'] },
    'cab-a/hub-2': { id: 'cab-a/hub-2', title: 'USB hub 2', node: 'hub', location: 'Cabinet A, DIN rail 2', ports: ['usb-4', 'usb-5'] },
    'cab-b/onboard': { id: 'cab-b/onboard', title: 'Onboard UARTs', node: 'hub', location: 'Cabinet B, gateway board', ports: ['s-0', 's-1'] }
}

const ROOTS = ['cab-a', 'cab-b']

/** Fresh per process, like any component's incarnation: a restart is a new world, not a new page. */
const INCARNATION = `${NAME}-${Date.now().toString(36)}`

const asRow = ({ id, title, node, port: device, baudrate, status, errors, description }: PortDetail): PortRow => ({
    id,
    title,
    node,
    port: device,
    baudrate,
    status,
    errors,
    description
})

const asBranchRow = ({ id, title, node, location }: BranchRow): BranchRow => ({ id, title, node, location })

// --------------------------------------------------------------------------- the component

const text = { type: { kind: 'string' as const } }
const maybeText = { type: { kind: 'string' as const }, optional: true }
const maybeCount = { type: { kind: 'number' as const }, optional: true }

@rpcNamespace('ports')
class SerialPorts extends RpcComponent<RackProps, RackState> {
    private revision = 1
    private readonly drift: ReturnType<typeof setInterval>

    constructor() {
        super({ host: 'edge-gw-1', udev: '255.0' }, { open: 0, faulted: 0, errors: 0 })
        this.recount()
        // Something moving, so a detail view proves it is *watched* rather than fetched once. A
        // port's error count is exactly the field that changes while somebody is looking at it,
        // which is usually why they opened it.
        this.drift = setInterval(() => this.wobble(), 3000)
        this.drift.unref?.()
    }

    /**
     * The summary in the component's own state, beside the resource.
     *
     * Both, because they answer different questions: how is the rack, and which port is it. The
     * first is three numbers a subscription carries for nothing; the second is eight rows a caller
     * asks for when it wants them.
     */
    private recount() {
        const all = Object.values(ports)
        this.setState({
            open: all.filter((one) => one.status === 'open').length,
            faulted: all.filter((one) => one.status === 'fault').length,
            errors: all.reduce((total, one) => total + one.errors, 0)
        })
    }

    private wobble() {
        const faulted = Object.values(ports).filter((one) => one.status === 'fault')
        if (!faulted.length) return
        for (const one of faulted) {
            one.errors += 1 + Math.floor(Math.random() * 3)
            one.framingErrors += 1
            one.lastError = `framing error at ${new Date().toISOString().slice(11, 19)}`
        }
        // The revision a cache reads to decide whether to ask again. Without moving it, a tick over
        // this resource is answered from the last page and the counts sit still on screen while the
        // rack behind them does not.
        this.revision += 1
        this.recount()
    }

    /**
     * Clear a port's error counters and bring it back up.
     *
     * An `idempotent-command` because it is one: resetting a port twice leaves it in the state
     * resetting it once did, so a console offering a retry after an uncertain outcome is offering
     * something safe. The row action beside it in the console names *this* method - the component's
     * own, already ruled on by `authorize()` and the owner fence - rather than a verb of the
     * console's invention.
     */
    @rpc({ semantics: 'idempotent-command' })
    resetPort(id: string): { port: string; status: string } {
        const one = ports[id]
        if (!one) throw new Error(`no port ${id}`)
        one.errors = 0
        one.framingErrors = 0
        one.parityErrors = 0
        one.overruns = 0
        one.lastError = ''
        if (one.status === 'fault') one.status = 'open'
        this.revision += 1
        this.recount()
        return { port: one.port, status: one.status }
    }

    /** Close a port. Declared with `confirm` in the resource, because it stops a line talking. */
    @rpc({ semantics: 'idempotent-command' })
    closePort(id: string): { port: string; status: string } {
        const one = ports[id]
        if (!one) throw new Error(`no port ${id}`)
        one.status = 'closed'
        one.baudrate = 0
        one.openedAt = ''
        this.revision += 1
        this.recount()
        return { port: one.port, status: one.status }
    }

    dataResources(): readonly RpcDataResource[] {
        return [
            {
                path: ['ports'],
                verbs: ['getChildren', 'getOne'],
                shape: 'tree',
                // The children of any one branch here resemble each other: cabinets under the root,
                // hubs under a cabinet, ports under a hub. So the values arrangement is what opens -
                // reading the error count down a column is the job this rack exists for. A reader
                // who wants the hierarchy switches to structure and the console remembers it.
                children: 'alike',
                label: 'Serial ports',
                // The four worth reading down a column, and `description` deliberately not among
                // them. Every field stays selectable; this decides only what is shown first.
                presentation: { defaultColumns: ['port', 'baudrate', 'status', 'errors'] },
                // Methods this component already has, said to apply to a row. The declaration adds
                // no capability whatsoever - `resetPort` is an ordinary `@rpc` method, already in
                // `describe()`, already ruled on. What this carries is the one fact a viewer cannot
                // work out for itself: which method belongs to which row.
                // Neither declares `appliesTo`, which means leaves - and leaves is what these are
                // about. A cabinet is not a thing `resetPort` can be called on, and a console that
                // drew the button there would be offering a command that throws, which an operator
                // discovers by pressing it. On a flat list the default shows every row, because
                // every row of a list is a leaf.
                actions: [
                    { method: 'resetPort', label: 'reset' },
                    { method: 'closePort', label: 'close', confirm: true }
                ],
                row: {
                    kind: 'object',
                    fields: {
                        id: text,
                        title: text,
                        node: text,
                        location: maybeText,
                        port: maybeText,
                        baudrate: maybeCount,
                        status: maybeText,
                        errors: maybeCount,
                        description: maybeText,
                        parity: maybeText,
                        dataBits: maybeCount,
                        stopBits: maybeCount,
                        flowControl: maybeText,
                        driver: maybeText,
                        devicePath: maybeText,
                        framingErrors: maybeCount,
                        parityErrors: maybeCount,
                        overruns: maybeCount,
                        bytesIn: maybeCount,
                        bytesOut: maybeCount,
                        openedAt: maybeText,
                        lastError: maybeText,
                        connectedTo: maybeText,
                        ports: maybeCount,
                        faults: maybeCount
                    }
                }
            }
        ]
    }

    dataRequest(method: RpcDataMethod, resource: RpcResource, params: RpcGetChildrenParams & RpcGetOneParams): RpcGetChildrenResult | RpcGetOneResult {
        if (resource[0] !== 'ports') throw new Error(`no such resource ${resource.join('.')}`)
        const stamp = { epoch: INCARNATION, revision: this.revision }

        if (method === 'getOne') {
            // Answered for **every** id this resource hands out, branches included. A resource that
            // declares the verb and then refuses half the ids it gave you would be worse than one
            // that never declared it: nothing in a row says whether it can be opened, so a viewer
            // can only find out by trying, and finding out means an operator clicking a row that
            // does nothing.
            const one = ports[params.id]
            if (one) return { data: one, ...stamp }
            const branch = branches[params.id]
            if (branch)
                return {
                    data: {
                        ...asBranchRow(branch),
                        ports: branch.ports?.length ?? branch.children?.length ?? 0,
                        faults: (branch.ports ?? []).filter((id) => ports[id]?.status === 'fault').length
                    },
                    ...stamp
                }
            // Absent rather than an error: an id can go between the branch that named it and the
            // click that opened it, and that race is not a fault in this node.
            return stamp
        }

        if (method !== 'getChildren') throw new Error(`ports answers getChildren and getOne, not ${method}`)

        const parent = params.parentId === undefined ? undefined : branches[params.parentId]
        const rows: (PortRow | BranchRow)[] =
            params.parentId === undefined
                ? ROOTS.map((id) => asBranchRow(branches[id]))
                : parent?.children
                  ? parent.children.map((id) => asBranchRow(branches[id]))
                  : (parent?.ports ?? []).map((id) => asRow(ports[id]))

        return {
            data: rows,
            ids: rows.map((row) => row.id),
            // A port is a leaf; a cabinet and a hub are not. This is the flag that draws an
            // expander before anybody has asked to expand.
            hasChildren: rows.map((row) => row.node !== 'port'),
            total: rows.length,
            ...stamp
        }
    }
}

// --------------------------------------------------------------------------- the peer

const rack = new SerialPorts()

const server = new RpcServer({
    name: NAME,
    // A port of its own, or somebody else's network. The second is what makes this useful beside
    // another example rather than only instead of one.
    transports: [HUB ? { connect: HUB } : { port: PORT }],
    schema: contract,
    // Without this the peer answers ClassNotFound to describe(), and a console can list it but
    // never show what it is. A peer that expects to be browsed opts in.
    exposeIntrospection: true,
    // On here, where a plant would leave it off: this example declares its row type twice - once as
    // `PortRow` for the compiler and once as `row` for the wire - and this is what catches them
    // disagreeing, in the example whose job is to be read.
    validateResults: true
})
server.exposeClassInstance(rack)
await server.ready()

process.stdout.write(`rack '${NAME}' ${HUB ? `joined ${HUB}` : `on port ${PORT}`}: 2 cabinets, 3 hubs, 8 ports, one faulted and drifting\n`)
process.stdout.write(`next: ${HUB ? 'open the console already pointed at that hub' : `source-rpc console --hub http://localhost:${PORT}`}\n`)

// The drift timer is unref'd, so it holds nothing open and needs no clearing here.
const stop = async () => {
    await server.close()
    process.exit(0)
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
