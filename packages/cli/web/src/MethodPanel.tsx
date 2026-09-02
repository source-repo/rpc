import { useState } from 'react'
import { ArgumentField, ConsoleService, DescribedMethod, FieldState, initialText, isOptional, requiredPart, ServerDescription, toValue, typeText, Uncertain, useCommanding } from '@source-repo/react'
import type { RpcMethodSemantics, RpcOperations } from '@source-repo/rpc'

/** How many times the repeat button calls. Enough for a p50 to mean something, few enough to wait for. */
const REPEAT = 20

/** The command line that would make the same call, so a call worth making here can leave the browser. */
const asCommand = (peer: string, namespace: string, method: string, args: unknown[], network: { broker?: string; hub?: string; prefix?: string }) => {
    const where = [
        ...(network.broker ? ['--broker', network.broker] : []),
        ...(network.hub ? ['--hub', network.hub] : []),
        ...(network.prefix ? ['--prefix', network.prefix] : [])
    ]
    // Quoted only where a shell would otherwise take it apart, so the common case stays readable.
    const word = (value: unknown) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value)
        return /^[A-Za-z0-9._@/:+-]+$/.test(text ?? '') ? text : `'${String(text).replace(/'/g, "'\\''")}'`
    }
    return ['msgrpc', 'call', peer, `${namespace}.${method}`, ...args.map(word), ...where].join(' ')
}

/**
 * Argument sets worth keeping, in the browser rather than on the console.
 *
 * Keyed by namespace and method rather than by peer, so a set saved against one cell is offered on
 * the next one - which is the case that matters, since the reason to save a setpoint sequence is
 * usually that you are about to do it to five more cabinets.
 */
const presetKey = (namespace: string, method: string) => `msgrpc.presets.${namespace}.${method}`

interface Preset {
    label: string
    texts: string[]
    include: boolean[]
}

const readPresets = (namespace: string, method: string): Preset[] => {
    try {
        const stored = window.localStorage.getItem(presetKey(namespace, method))
        return stored ? (JSON.parse(stored) as Preset[]) : []
    } catch {
        // A browser with storage turned off is not a reason for the form to stop working.
        return []
    }
}

const writePresets = (namespace: string, method: string, presets: Preset[]) => {
    try {
        window.localStorage.setItem(presetKey(namespace, method), JSON.stringify(presets))
    } catch {
        // Full, private, or refused. Losing a preset is not worth an error in the console.
    }
}

/**
 * Put text on the clipboard, from an address where there may not be one.
 *
 * `navigator.clipboard` is secure-context only, exactly as `randomUUID` is, and the optional chain
 * that used to guard it here short-circuited into silence: on a plain-HTTP address the button
 * flashed nothing and left the operator to conclude the console was broken. The pre-2015 way still
 * works everywhere, so it is what such an origin gets.
 */
const copyText = async (text: string): Promise<boolean> => {
    if (navigator.clipboard)
        try {
            await navigator.clipboard.writeText(text)
            return true
        } catch {
            // Refused by permission rather than absent, which the same fallback also answers.
        }
    const area = document.createElement('textarea')
    area.value = text
    // Off-screen rather than hidden, because `display: none` cannot be selected - and a visible
    // flash of the command being copied is the other thing to avoid.
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    document.body.append(area)
    area.select()
    try {
        return document.execCommand('copy')
    } finally {
        area.remove()
    }
}

const median = (values: number[]) => {
    if (!values.length) return 0
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
}

/**
 * One method, folded shut until someone wants to try it. Open, it is a form with a field per
 * argument and the result underneath.
 */
export const MethodPanel = ({
    peer,
    namespace,
    method,
    types,
    service,
    network,
    operations,
    relay
}: {
    peer: string
    namespace: string
    method: DescribedMethod
    types: ServerDescription['types']
    service: ConsoleService
    network: { broker?: string; hub?: string; prefix?: string }
    /** This page's own registry, so a relayed command is recorded as the command it is about. */
    operations: RpcOperations
    /** The console relaying it. A relayed command has two places to fail, and they differ. */
    relay: string
}) => {
    const params = method.params ?? []
    const names = method.paramNames ?? params.map((_, index) => `argument ${index}`)
    const [open, setOpen] = useState(false)
    const [fields, setFields] = useState<FieldState[]>(() =>
        params.map((type) => ({ text: initialText(type, types), include: !isOptional(type) }))
    )
    const [busy, setBusy] = useState(false)
    // A non-repeatable command is armed rather than fired: the first click turns the button into a
    // confirmation in the console's own chrome, and only the second sends. Native chrome and not
    // window.confirm - the trust model grants UI to the console, never to a dialog the browser
    // draws over it, and a blocking dialog freezes every live pane behind it.
    const [confirming, setConfirming] = useState(false)
    const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
    // Kept rather than shown once and forgotten: one call's timing says almost nothing, and the
    // question worth asking of a device is what it does the twentieth time.
    const [times, setTimes] = useState<number[]>([])
    const [copied, setCopied] = useState(false)
    const [presets, setPresets] = useState<Preset[]>(() => readPresets(namespace, method.name))

    // Written the way the source declares it - `mode?: 'auto' | 'manual'` rather than the `| null`
    // the schema encodes optionality as, which reads like a value the method accepts.
    const signature = `${method.name}(${
        method.params ? params.map((type, i) => `${names[i]}${isOptional(type) ? '?' : ''}: ${typeText(requiredPart(type))}`).join(', ') : '…'
    })${method.returns ? `: ${typeText(method.returns)}` : ''}`

    /** The arguments as the form has them, or a message saying why they cannot be built. */
    const argumentsNow = () => {
        // Trailing arguments left out are simply not sent, which is what optional means.
        const args = params.map((type, index) => (fields[index].include ? toValue(fields[index].text, type, types) : undefined))
        while (args.length && args[args.length - 1] === undefined && isOptional(params[args.length - 1])) args.pop()
        return args
    }

    /**
     * The key that makes a second press of Call another attempt at *this* command rather than a
     * second one, and the offer to use it. Held here so it survives the outcome being drawn.
     */
    const commanding = useCommanding()

    const invoke = async (repeat = 1) => {
        let args: unknown[]
        try {
            args = argumentsNow()
        } catch (e) {
            setOutcome({ ok: false, text: (e as Error).message })
            return
        }
        setBusy(true)
        setOutcome(null)
        const collected: number[] = []
        let last: { ok: boolean; text: string } | null = null

        /**
         * One attempt, under a key when there is one.
         *
         * The key travels as far as the console and no further on its own: the call to the plant is
         * made by *that* process, so a key minted here reaches the wire only because the relaying
         * `call` verb carries it.
         */
        const once = async (idempotencyKey?: string) => {
            const answer = await service.call(peer, namespace, method.name, args, idempotencyKey)
            collected.push(answer.ms)
            last = answer.error
                ? { ok: false, text: `${answer.code ? answer.code + ': ' : ''}${answer.error}` }
                : { ok: true, text: `${JSON.stringify(answer.result, null, 2) ?? 'undefined'}\n\n// ${answer.ms} ms` }
            setOutcome(last)
            // Thrown rather than returned so one classification decides everything: the relay reports
            // a failure as a value, and turning it back into an error here is what lets the same
            // `mayHaveRun` the operations registry uses decide whether a retry is even offered.
            if (answer.error) throw Object.assign(new Error(answer.error), { code: answer.code })
        }

        try {
            // Repeating is deliberately **not** one command tried many times - the button says
            // twenty calls and means twenty, which for a command or an undeclared method is twenty
            // commands. So it carries no key, and offers no retry: there is no single intent to be
            // another attempt at.
            if (repeat > 1) for (let attempt = 0; attempt < repeat; attempt++) await once()
            else
                await commanding.run(`${namespace}.${method.name}`, (idempotencyKey) =>
                    // Recorded as the command it is about rather than as the relay that carried it.
                    // The console reports the plant's answer as a *value*, so this page's own entry
                    // for `console.call` says `succeeded` - correctly, the relay worked - while the
                    // command may have been left in the air. A tray built only on what the client
                    // saw would show the one outcome an operator must never be shown wrongly.
                    operations.relayed(
                        {
                            via: relay,
                            target: peer,
                            namespace,
                            method: method.name,
                            ...(method.semantics ? { semantics: method.semantics as RpcMethodSemantics } : {}),
                            idempotencyKey
                        },
                        () => once(idempotencyKey)
                    )
                )
        } catch (failure) {
            // `once` sets the outcome before it throws, and one that fails stops the repeat - twenty
            // identical failures are one finding. A throw from *before* the call is a different
            // thing, with nothing on screen to have explained it: minting a key, resolving the
            // relay. Swallowing that one leaves a button that does nothing at all, which is how a
            // `crypto.randomUUID` absent outside a secure context survived a session of being
            // pressed. Anything that never reached `once` is reported here.
            if (!last) setOutcome({ ok: false, text: (failure as Error)?.message ?? String(failure) })
        } finally {
            setTimes((current) => [...current, ...collected].slice(-200))
            setBusy(false)
        }
    }

    /** Named by what it holds: a preset called "1200, auto" needs no explaining, and no dialog. */
    const savePreset = () => {
        const label = fields.map((field) => (field.include ? field.text : '—')).join(', ') || 'no arguments'
        const preset: Preset = { label, texts: fields.map((field) => field.text), include: fields.map((field) => field.include) }
        const next = [preset, ...presets.filter((entry) => entry.label !== label)].slice(0, 8)
        setPresets(next)
        writePresets(namespace, method.name, next)
    }

    const applyPreset = (preset: Preset) =>
        setFields(fields.map((field, index) => ({ text: preset.texts[index] ?? field.text, include: preset.include[index] ?? field.include })))

    const forgetPreset = (label: string) => {
        const next = presets.filter((entry) => entry.label !== label)
        setPresets(next)
        writePresets(namespace, method.name, next)
    }

    const copyCommand = () => {
        let args: unknown[]
        try {
            args = argumentsNow()
        } catch {
            args = []
        }
        void copyText(asCommand(peer, namespace, method.name, args, network)).then((done) => {
            // Said rather than shrugged off: a copy that did not happen and a copy that did look
            // identical from the keyboard, and the operator pastes whatever was there before.
            if (!done) return setOutcome({ ok: false, text: 'this browser would not give the page the clipboard' })
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        })
    }

    return (
        <div className={`method${open ? ' open' : ''}`}>
            <button className="method-head" onClick={() => setOpen(!open)} aria-expanded={open}>
                <span className="chevron">{open ? '▾' : '▸'}</span>
                <code>{signature}</code>
                {/* The grade worth seeing before opening: a query reads as safe at a glance, and a
                    command that cannot be taken back says so from the list. Undeclared shows
                    nothing here - its warning belongs next to the button that would press it. */}
                {method.semantics === 'query' && <span className="sem query">query</span>}
                {method.semantics === 'idempotent-command' && <span className="sem idempotent">idempotent</span>}
                {method.semantics === 'non-repeatable-command' && <span className="sem once">won't repeat</span>}
            </button>
            {open && (
                <div className="method-body">
                    {params.length === 0 && <p className="muted">No arguments.</p>}
                    {params.map((type, index) => (
                        <ArgumentField
                            key={index}
                            name={names[index]}
                            type={type}
                            types={types}
                            state={fields[index]}
                            onChange={(next) => setFields(fields.map((field, i) => (i === index ? next : field)))}
                        />
                    ))}
                    {params.length > 0 && (presets.length > 0 || fields.length > 0) && (
                        <div className="presets">
                            {presets.map((preset) => (
                                <span key={preset.label} className="preset">
                                    <button className="toggle" onClick={() => applyPreset(preset)} title="put these arguments back in the form">
                                        {preset.label}
                                    </button>
                                    <button className="forget" onClick={() => forgetPreset(preset.label)} title="forget this one">
                                        ×
                                    </button>
                                </span>
                            ))}
                            <button className="toggle" onClick={savePreset} title="keep these arguments for next time">
                                save
                            </button>
                        </div>
                    )}
                    {method.rest && <p className="muted">Takes further {typeText(method.rest)} arguments, which this form does not send.</p>}
                    {!method.params && <p className="muted">No schema describes this method, so its arguments cannot be shown as fields.</p>}
                    {!method.semantics && (
                        <p className="muted">The contract does not say what calling this does. Treat it as a command until someone who knows says otherwise.</p>
                    )}
                    {confirming && (
                        <div className="confirm">
                            <span>
                                Not free to repeat — sent once, it has happened. Send <code>{method.name}</code>?
                            </span>
                            <button
                                className="primary"
                                onClick={() => {
                                    setConfirming(false)
                                    void invoke()
                                }}
                            >
                                send once
                            </button>
                            <button className="toggle" onClick={() => setConfirming(false)}>
                                cancel
                            </button>
                        </div>
                    )}
                    <div className="actions">
                        <button
                            className="primary"
                            onClick={() => (method.semantics === 'non-repeatable-command' ? setConfirming(true) : void invoke())}
                            disabled={busy || confirming}
                        >
                            {busy ? 'calling…' : 'Call'}
                        </button>
                        {/* The declaration is what buys the repeat button: benchmarking is for
                            methods whose contract says repeating them is free. On a non-repeatable
                            or undeclared method, twenty timed calls is twenty commands. */}
                        {(method.semantics === 'query' || method.semantics === 'idempotent-command') && (
                            <button className="toggle" onClick={() => void invoke(REPEAT)} disabled={busy} title="call it repeatedly and keep the timings">
                                ×{REPEAT}
                            </button>
                        )}
                        <button className="toggle" onClick={copyCommand} title="the command line that makes the same call">
                            {copied ? 'copied' : 'copy as CLI'}
                        </button>
                        {times.length > 0 && (
                            <span className="muted timing">
                                {times.length} call{times.length === 1 ? '' : 's'} · p50 {median(times)} ms · last {times[times.length - 1]} ms
                            </span>
                        )}
                    </div>
                    {outcome && <pre className={outcome.ok ? 'result' : 'result bad'}>{outcome.text}</pre>}
                    <Uncertain commanding={commanding} />
                </div>
            )}
        </div>
    )
}
