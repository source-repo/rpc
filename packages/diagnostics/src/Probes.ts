import type { RpcProbeKind } from './Variant.js'

/**
 * What a probe writes to, and the invariants that keep instrumentation from becoming the fault.
 *
 * A diagnostic variant runs on a plant. Every probe in it is code that was not in the approved
 * program, executing between statements that control machinery, so the design's safety invariants
 * are not aspirations here - they are the reason this file is as small and as dull as it is:
 *
 * - **Never throw into component logic.** Every entry point swallows its own failures. A probe that
 *   threw would turn *watching* a component into *breaking* one, and it would break it in the
 *   handler somebody was watching precisely because it was already going wrong.
 * - **Return the observed value unchanged**, by identity. `value` and `condition` hand back exactly
 *   what they were given, which is what makes them removable and what makes the program the program.
 * - **No unbounded allocation**, so a bounded ring and a byte cap on every encoded value. A
 *   component in a hot loop must not be able to fill a node's memory by being watched.
 * - **Never await, never reach the network, the filesystem or the plant.** A probe writes to an
 *   in-process buffer and returns. Anything else would be doing work the approved program did not
 *   ask for, on its stack, inside its deadline.
 */

/** One observation, in the terms a viewer draws. Kept small: there may be a great many of them. */
export interface RpcProbeSample {
    readonly probeId: string
    readonly kind: RpcProbeKind
    /** Monotonic within one sink, so a reader can order what it has and see what it missed. */
    readonly sequence: bigint
    /** How many times this probe has fired since the sink was created. */
    readonly executionCount: number
    readonly observedAt: string
    readonly conditionResult?: boolean
    readonly value?: RpcDiagnosticValue
}

/**
 * A value as a probe could safely render it.
 *
 * Rendered at capture rather than held, because holding a reference would keep an object alive for
 * as long as the buffer did and would report what it looks like *now* rather than what it was when
 * the probe fired. `truncated` and `unrepresentable` are stated rather than approximated: a viewer
 * showing a shortened string has to be able to say so, and a getter that throws is a fact about the
 * value rather than an error to hide.
 */
export interface RpcDiagnosticValue {
    readonly text: string
    readonly type: string
    readonly truncated?: boolean
    readonly unrepresentable?: string
}

export interface RpcProbeSinkOptions {
    /** How many samples are kept. The oldest goes when a new one arrives; a ring, not a log. */
    readonly maxSamples?: number
    /** The most bytes one encoded value may take. Everything past it is a truncation, and says so. */
    readonly maxValueBytes?: number
    /**
     * Probe ids whose values must never be captured, only counted.
     *
     * **Applied here rather than in the editor**, which is the design's rule and the only place it
     * can be true: a value redacted on the way to a screen has already been in a buffer, in a
     * message and in whatever logged either. A probe on a field classified beside its declaration
     * fires, is counted, and reports that its value was withheld - so the execution path is still
     * visible and the credential never leaves the process.
     */
    readonly withheld?: ReadonlySet<string>
    /** The clock, so a test need not compare timestamps it cannot predict. */
    readonly now?: () => number
}

/**
 * The latest value each probe saw, and how often it has fired.
 *
 * The design prefers this to publishing an event per hit, and the reason is arithmetic: a statement
 * in a loop running at a hundred hertz produces six thousand events a minute and one useful fact.
 * A table is bounded by the number of probes rather than by the rate of the program, which is what
 * makes watching a hot function cost the same as watching a cold one.
 */
export interface RpcProbeTable {
    readonly latest: { readonly [probeId: string]: RpcProbeSample }
    /** Samples the ring dropped since the sink was made. A hole a viewer cannot see is a lie. */
    readonly dropped: number
    /** How many samples have been written in total, which is what a freshness display counts. */
    readonly written: number
}

const DEFAULT_MAX_SAMPLES = 2000
const DEFAULT_MAX_VALUE_BYTES = 512

/**
 * Render a value inside a byte budget, and never throw doing it.
 *
 * A component's state can hold anything - a proxy whose getter throws, a structure with a cycle, a
 * bigint that `JSON.stringify` refuses. Every one of those arrives here as an ordinary value on an
 * ordinary line, and the correct outcome for all of them is a sample saying what could not be
 * rendered, never an exception on the component's stack.
 */
export const renderValue = (observed: unknown, maxValueBytes: number): RpcDiagnosticValue => {
    const type = observed === null ? 'null' : Array.isArray(observed) ? 'array' : typeof observed
    try {
        const text =
            typeof observed === 'string'
                ? observed
                : typeof observed === 'bigint'
                  ? `${observed}n`
                  : typeof observed === 'function'
                    ? `[function ${observed.name || 'anonymous'}]`
                    : typeof observed === 'object' && observed !== null
                      ? JSON.stringify(observed)
                      : String(observed)
        if (text === undefined) return { text: '[unrenderable]', type, unrepresentable: 'the value produced no text' }
        return text.length > maxValueBytes ? { text: text.slice(0, maxValueBytes), type, truncated: true } : { text, type }
    } catch (failure) {
        // A cycle, a throwing getter, a bigint inside an object. The sample still happens.
        return { text: '', type, unrepresentable: (failure as Error)?.message ?? 'the value could not be rendered' }
    }
}

/**
 * Where one activation's probes write.
 *
 * **Deliberately not a transport, even now that there is one.** Probes write here and return; the
 * diagnostics service reads this on its own schedule and publishes what it finds. A sink that
 * carried each sample onward would put a call on the component's stack for every statement it
 * executed - and a sink that could not drop would push back on the component, which is the one thing
 * observation must never do. The ring drops and counts what it dropped, and the count is published
 * beside the values so nobody mistakes a gap for quiet.
 */
export class RpcProbeSink {
    private readonly samples: RpcProbeSample[] = []
    private readonly counts = new Map<string, number>()
    private readonly latest = new Map<string, RpcProbeSample>()
    private readonly maxSamples: number
    private readonly maxValueBytes: number
    private readonly withheld: ReadonlySet<string>
    private readonly now: () => number
    private next = 1n
    /** How many samples the ring has dropped. A viewer that cannot see this cannot trust the trace. */
    private dropped_ = 0
    private written_ = 0

    constructor(options: RpcProbeSinkOptions = {}) {
        this.maxSamples = Math.max(1, options.maxSamples ?? DEFAULT_MAX_SAMPLES)
        this.maxValueBytes = Math.max(1, options.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES)
        this.withheld = options.withheld ?? new Set()
        this.now = options.now ?? Date.now
    }

    /**
     * The latest value per probe and the counters, which is what a session publishes as state.
     *
     * Bounded by how many probes there are rather than by how often they fired, so publishing costs
     * the same whether the component ticked once or ten thousand times since the last one.
     */
    table(): RpcProbeTable {
        return { latest: Object.fromEntries(this.latest), dropped: this.dropped_, written: this.written_ }
    }

    get depth(): number {
        return this.samples.length
    }

    /**
     * The bounds this sink enforces.
     *
     * Public because they are what a node advertises as its limits, and a viewer plans around them:
     * a value cap it cannot see is a truncation it cannot explain, and a ring size it cannot see is
     * a trace length it cannot ask for.
     */
    get bounds(): { readonly maxSamples: number; readonly maxValueBytes: number } {
        return { maxSamples: this.maxSamples, maxValueBytes: this.maxValueBytes }
    }

    get dropped(): number {
        return this.dropped_
    }

    /** What the sink holds, oldest first. A copy, because a component must not be handed the ring. */
    drain(): readonly RpcProbeSample[] {
        const held = [...this.samples]
        this.samples.length = 0
        return held
    }

    peek(): readonly RpcProbeSample[] {
        return [...this.samples]
    }

    private write(probeId: string, kind: RpcProbeKind, extra: Partial<RpcProbeSample> = {}): void {
        const executionCount = (this.counts.get(probeId) ?? 0) + 1
        this.counts.set(probeId, executionCount)
        if (this.samples.length >= this.maxSamples) {
            this.samples.shift()
            this.dropped_++
        }
        const sample: RpcProbeSample = { probeId, kind, sequence: this.next++, executionCount, observedAt: new Date(this.now()).toISOString(), ...extra }
        this.samples.push(sample)
        this.latest.set(probeId, sample)
        this.written_++
    }

    /** A value, unless this probe is on something classified - then the fact that it fired, only. */
    private rendered(probeId: string, observed: unknown): RpcDiagnosticValue {
        return this.withheld.has(probeId) ? { text: '', type: 'withheld', unrepresentable: 'this probe is on a field classified beside its declaration, so its value is not captured' } : renderValue(observed, this.maxValueBytes)
    }

    /**
     * The receiver a generated variant calls through - the object the artifact imports as
     * `__rpcProbe`, with one member per emitted probe form.
     *
     * Every member is wrapped so that nothing it does can escape into the component. The wrapping
     * forms return the observed value from a `finally`-free path on purpose: the recording happens
     * first, and the return is the last thing that can go wrong, so the value comes back even if the
     * sink is full, broken, or has been closed underneath.
     */
    get receiver() {
        const write = (probeId: string, kind: RpcProbeKind, extra?: Partial<RpcProbeSample>) => {
            try {
                this.write(probeId, kind, extra)
            } catch {
                // Nothing. A sink that failed is a screen missing a value; a probe that threw is a
                // plant with a fault the program did not have.
            }
        }
        return {
            entry: (probeId: string): void => write(probeId, 'function-entry'),
            exit: (probeId: string): void => write(probeId, 'function-exit'),
            statement: (probeId: string): void => write(probeId, 'statement'),
            branch: (probeId: string): void => write(probeId, 'branch'),
            value: <T>(probeId: string, observed: T): T => {
                write(probeId, 'value', { value: this.rendered(probeId, observed) })
                return observed
            },
            condition: (probeId: string, observed: boolean): boolean => {
                write(probeId, 'condition', { conditionResult: observed, value: this.rendered(probeId, observed) })
                return observed
            }
        }
    }
}

/** The type a generated artifact expects to import. Named so an adapter in another language can match it. */
export type RpcProbeReceiver = RpcProbeSink['receiver']
