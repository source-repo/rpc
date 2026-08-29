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
    /** What each tracepoint does when hit, by probe id. Changed without rebuilding the artifact. */
    readonly tracepoints?: { readonly [probeId: string]: RpcTracepointPolicy }
    /** How many tracepoint captures are held between publications. */
    readonly maxCaptures?: number
    /**
     * Told when a probe with a stop policy has captured. Must not block, and must not throw.
     *
     * The one call this sink makes out of itself, and it is bounded by contract: a supervisor's job
     * here is to put a barrier on a queue, which is a queue insertion and not a wait. Anything it
     * throws is swallowed, because a probe that threw would be the fault rather than the report.
     */
    readonly onStop?: (probeId: string) => void
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

/**
 * What a tracepoint does when it is hit, held by the sink rather than compiled into the artifact.
 *
 * The design's split: changing a *condition* may require rebuilding the variant, because a condition
 * runs inside the component and is compiled in. Everything here is about what the sink does with a
 * hit that already happened - how many to skip, what to print - so changing it needs no rebuild, and
 * a plant is not swapped to reword a message.
 */
export interface RpcTracepointPolicy {
    /** The hit at which capturing begins. Earlier hits are counted and not captured. */
    readonly hitCount?: number
    /** `{symbol}` is filled in from what was captured. Rendered here, inside the byte budget. */
    readonly messageTemplate?: string
    /**
     * Whether this probe also asks the component to stop at its next safe boundary.
     *
     * Policy rather than artifact, which is the design's rule stated exactly: *adding an
     * unconditional stop policy to an existing probe does not require rebuilding the variant.* A
     * tracepoint and a safe-boundary breakpoint are the same compiled probe with different
     * instructions to the sink, so turning one into the other costs a map entry rather than a swap
     * of the code running on a plant.
     *
     * The stop does not happen here. The sink records the capture and calls `onStop`, and the
     * handler runs on to its end - which is what makes it a *safe boundary* rather than a halt.
     */
    readonly stop?: boolean
}

/** One tracepoint hit: what was captured, what it read as, and when. An event, not a state row. */
export interface RpcTracepointCapture {
    readonly probeId: string
    readonly sequence: bigint
    readonly hit: number
    readonly observedAt: string
    readonly captured: { readonly [symbol: string]: RpcDiagnosticValue }
    readonly message?: string
    /** Whether this capture also asked the component to stop at its next safe boundary. */
    readonly stopRequested?: boolean
}

const DEFAULT_MAX_SAMPLES = 2000
const DEFAULT_MAX_VALUE_BYTES = 512
/** How many captures are held between publications. A tracepoint on a hot line is still bounded. */
const DEFAULT_MAX_CAPTURES = 200

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
 * Fill `{symbol}` from what was captured, inside the same byte budget as everything else.
 *
 * A placeholder naming something that was not captured is left as it was written rather than
 * replaced with `undefined`: the difference between *this was empty* and *you did not ask for this*
 * is the whole content of the message when somebody is reading it at speed. A withheld field renders
 * as its withheld marker here too, because a message template is not a way around a classification.
 */
const fill = (template: string, captured: { readonly [symbol: string]: RpcDiagnosticValue }, maxValueBytes: number): string => {
    const filled = template.replace(/\{([A-Za-z_$][\w$]*)\}/g, (whole, symbol: string) => {
        const value = captured[symbol]
        return value ? (value.unrepresentable ? `[${value.unrepresentable}]` : value.text) : whole
    })
    return filled.length > maxValueBytes ? `${filled.slice(0, maxValueBytes)}…` : filled
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
    private readonly tracepoints: { readonly [probeId: string]: RpcTracepointPolicy }
    private readonly captures: RpcTracepointCapture[] = []
    private readonly maxCaptures: number
    private readonly onStop?: (probeId: string) => void
    private readonly now: () => number
    private next = 1n
    private discarded_ = 0
    /** How many samples the ring has dropped. A viewer that cannot see this cannot trust the trace. */
    private dropped_ = 0
    private written_ = 0

    constructor(options: RpcProbeSinkOptions = {}) {
        this.maxSamples = Math.max(1, options.maxSamples ?? DEFAULT_MAX_SAMPLES)
        this.maxValueBytes = Math.max(1, options.maxValueBytes ?? DEFAULT_MAX_VALUE_BYTES)
        this.withheld = options.withheld ?? new Set()
        this.maxCaptures = Math.max(1, options.maxCaptures ?? DEFAULT_MAX_CAPTURES)
        this.tracepoints = options.tracepoints ?? {}
        if (options.onStop) this.onStop = options.onStop
        this.now = options.now ?? Date.now
    }

    /** The captures taken since the last drain, oldest first. Handed over rather than copied. */
    drainCaptures(): readonly RpcTracepointCapture[] {
        const held = [...this.captures]
        this.captures.length = 0
        return held
    }

    /** How many captures the bound has discarded. Published, like every other drop. */
    get discarded(): number {
        return this.discarded_
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
            },
            /**
             * A tracepoint hit. Counted always, captured when the condition and the hit count agree.
             *
             * The count happens even when the condition is false, and that is the useful half on a
             * plant: *this line ran four thousand times and the condition never held* is an answer,
             * and a probe that recorded nothing when it did not capture would leave somebody unable
             * to tell it from a line that was never reached.
             */
            tracepoint: (probeId: string, condition: boolean, captured: Readonly<Record<string, unknown>>): void => {
                try {
                    this.write(probeId, 'breakpoint', { conditionResult: condition })
                    if (!condition) return
                    const policy = this.tracepoints[probeId] ?? {}
                    const hit = this.counts.get(probeId) ?? 1
                    if (policy.hitCount !== undefined && hit < policy.hitCount) return
                    this.capture(probeId, hit, captured, policy)
                } catch {
                    // Same rule as everywhere here: a probe that threw would be the fault.
                }
            }
        }
    }

    private capture(probeId: string, hit: number, captured: Readonly<Record<string, unknown>>, policy: RpcTracepointPolicy): void {
        const rendered: { [symbol: string]: RpcDiagnosticValue } = {}
        for (const [symbol, value] of Object.entries(captured)) rendered[symbol] = this.rendered(probeId, value)
        if (this.captures.length >= this.maxCaptures) {
            this.captures.shift()
            this.discarded_++
        }
        this.captures.push({
            probeId,
            sequence: this.next++,
            hit,
            observedAt: new Date(this.now()).toISOString(),
            captured: rendered,
            stopRequested: policy.stop === true,
            ...(policy.messageTemplate ? { message: fill(policy.messageTemplate, rendered, this.maxValueBytes) } : {})
        })
        // Asked for after the capture is recorded, so a pause that begins immediately still finds the
        // capture that caused it waiting to be published.
        if (policy.stop) this.onStop?.(probeId)
    }
}

/** The type a generated artifact expects to import. Named so an adapter in another language can match it. */
export type RpcProbeReceiver = RpcProbeSink['receiver']
