import { RPC_WRITE_VERBS, validateWritePermissions, type RpcRefusedWrite, type RpcWritePermissions, type RpcWriteVerb } from '@source-repo/rpc'
import type { Catalogue, ColumnInfo, TableInfo } from './Catalogue.js'
import { RelationalRefusal } from './Filter.js'

/**
 * A permission document, resolved against the database it points at - and every reason a line of it
 * could not be honoured.
 *
 * The read half already does this with `props.unserved`: a table missing from a list is otherwise
 * indistinguishable from a table nobody asked for, so the absence is reported rather than left to be
 * noticed. Writes need it more, not less. An operator who allow-listed `work_orders` and misspelled
 * it gets a node that refuses every edit with "not writable here", which reads exactly like a
 * deliberate policy, and there is nothing on the screen to say the policy was never loaded.
 *
 * **A rule is honoured whole or dropped whole.** A rule naming four columns of which one does not
 * exist is not silently narrowed to three: the person who wrote it believed something about that
 * table that is false, and the next line of the document may be wrong in a way this cannot see. The
 * same judgement `readCatalogue` makes about a table whose declared id is not one of its columns.
 */

const refuse = (message: string): never => {
    throw new RelationalRefusal(message)
}

export interface ResolvedWrite {
    readonly table: TableInfo
    readonly verbs: ReadonlySet<RpcWriteVerb>
    /** The columns a caller may write, in catalogue order, resolved to what the database actually has. */
    readonly columns: readonly ColumnInfo[]
    readonly byName: ReadonlyMap<string, ColumnInfo>
}

export interface ResolvedWrites {
    readonly writable: ReadonlyMap<string, ResolvedWrite>
    readonly refused: readonly RpcRefusedWrite[]
}

/**
 * What a table's rule means once the database has been consulted.
 *
 * Four things are refused here rather than at the moment somebody presses a button, because all
 * four are properties of the deployment rather than of the call, and a deployment fault should be
 * visible on the node's own props from the second it starts.
 */
export const resolveWrites = (catalogue: Catalogue, permissions: RpcWritePermissions | undefined): ResolvedWrites => {
    const writable = new Map<string, ResolvedWrite>()
    const refused: RpcRefusedWrite[] = []
    for (const [name, rule] of Object.entries(permissions ?? {})) {
        const table = catalogue.byName.get(name)
        if (!table) {
            // The read side already worked out why, where it knows - so an operator sees "a
            // composite primary key, which has no single id" rather than a second, vaguer sentence
            // about the same table.
            const unserved = catalogue.unserved.find((one) => one.name === name)
            refused.push({ resource: name, reason: unserved ? `not served for reading either: ${unserved.reason}` : 'not a table this node serves' })
            continue
        }
        // A view is a query, and what an insert through one does - or whether it does anything at
        // all - is the engine's own business and differs between the three. The read side serves a
        // view happily because reading a query is what a query is for; writing through one is a
        // guess about somebody else's schema, and this package refuses where it would have to guess.
        if (table.isView) {
            refused.push({ resource: name, reason: 'a view, and whether a write through one reaches a table is the engine’s business rather than this node’s' })
            continue
        }
        const columns: ColumnInfo[] = []
        let bad: string | undefined
        for (const wanted of rule.columns ?? []) {
            const column = table.byName.get(wanted)
            if (!column) {
                bad = `names ${wanted}, which is not a column of ${name}`
                break
            }
            // No unambiguous encoding for bytes exists in a JSON row - base64 and an array of
            // numbers are both defensible and neither is declared - so a byte column is refused
            // rather than written through whichever the driver happened to accept.
            if (column.kind === 'bytes') {
                bad = `names ${wanted}, which holds ${column.dataType}: this node does not write bytes, because a JSON row has no declared encoding for one`
                break
            }
            columns.push(column)
        }
        if (bad) {
            refused.push({ resource: name, reason: bad })
            continue
        }
        // A create with nothing it may set can still be legitimate on a table of defaults, but a
        // rule that offers `update` and no columns can never do anything at all - and the library's
        // own validation already refuses that shape, so reaching it means the document was built
        // rather than written.
        writable.set(name, { table, verbs: new Set(rule.verbs), columns, byName: new Map(columns.map((column) => [column.name, column])) })
    }
    return { writable, refused }
}

/** The rules, checked before a connection is opened - so a malformed document refuses the node. */
export const readWritePermissions = (permissions: RpcWritePermissions | undefined): RpcWritePermissions | undefined =>
    permissions === undefined ? undefined : validateWritePermissions(permissions, 'writes')

/**
 * The resolved rule for a table and a verb, or a refusal naming what is writable.
 *
 * Both halves of the refusal matter. Naming the table says the rule exists and this verb is not in
 * it; naming what *is* writable is the answer to "can I change this", which is the question behind
 * every one of these and is otherwise a guessing game. `describe()` already publishes the namespace
 * and `writable()` already publishes the list, so this discloses nothing a caller permitted to be
 * here could not read directly.
 */
export const writeFor = (writes: ResolvedWrites, table: string, verb: RpcWriteVerb): ResolvedWrite => {
    const resolved = writes.writable.get(table)
    if (!resolved) {
        const names = [...writes.writable.keys()]
        return refuse(names.length ? `${table} is not writable on this node - it accepts writes to ${names.join(', ')}` : `${table} is not writable on this node, which accepts no writes at all`)
    }
    if (!resolved.verbs.has(verb)) return refuse(`${table} does not answer ${verb} - it answers ${[...RPC_WRITE_VERBS].filter((one) => resolved.verbs.has(one)).join(', ')}`)
    return resolved
}

/**
 * One value, as the column will actually store it - or a refusal.
 *
 * **Checked rather than coerced**, which is the same judgement the filter side makes about an
 * operand and matters more here: a filter that coerces finds the wrong rows and can be noticed, and
 * a write that coerces *stores* the wrong value and cannot. `'80'` into a numeric setpoint is the
 * case worth having in mind - JavaScript will happily make that 80, MySQL will too, and the one
 * time the string is `'8O'` the column ends up holding 0 with nothing anywhere reporting it.
 *
 * A date arrives as a string, never as a number, for the reason the filter side gives: epoch seconds
 * and epoch milliseconds are both ordinary conventions and a number does not say which.
 *
 * A JSON column takes any JSON value and is bound as text, because that is what all three engines
 * accept and what none of them would accept as a live object.
 */
export const bindValue = (column: ColumnInfo, value: unknown): unknown => {
    if (value === undefined) return refuse(`${column.name} was given no value - omit the field to leave it alone, or send null to clear it`)
    if (value === null) {
        if (!column.nullable) return refuse(`${column.name} cannot be null - it is declared ${column.dataType} not null`)
        return null
    }
    if (column.kind === 'json') return JSON.stringify(value)
    // Nothing is known about what this column holds, so nothing can be checked about the value. A
    // primitive is passed to the driver, which is the same permissiveness the filter side extends to
    // an unknown column - refusing to write a type this file has not heard of would make an
    // unfamiliar column an unusable one.
    if (column.kind === 'unknown') {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
        return refuse(`${column.name} holds ${column.dataType}, which this node does not recognise, so it accepts only a string, a number or a boolean for it`)
    }
    if (typeof value === 'string') {
        if (column.kind === 'string') return value
        if (column.kind === 'date') {
            const at = Date.parse(value)
            if (!Number.isFinite(at)) return refuse(`${column.name} takes a date, and ${JSON.stringify(value)} is not one - send an ISO 8601 string`)
            // Bound as a Date rather than as the text that arrived, so all three engines are handed
            // the same instant rather than three interpretations of a string.
            return new Date(at)
        }
        return refuse(`${column.name} holds ${column.dataType} and was given a string - a value is checked rather than converted, because a conversion that goes wrong is stored rather than reported`)
    }
    if (typeof value === 'number') {
        if (column.kind === 'number') return value
        return refuse(
            column.kind === 'date'
                ? `${column.name} takes a date as an ISO 8601 string - a number is ambiguous between seconds and milliseconds, and neither reading is safe to guess`
                : `${column.name} holds ${column.dataType} and was given a number`
        )
    }
    if (typeof value === 'boolean') {
        if (column.kind === 'boolean') return value
        return refuse(`${column.name} holds ${column.dataType} and was given a boolean`)
    }
    return refuse(`${column.name} holds ${column.dataType} and was given ${Array.isArray(value) ? 'an array' : 'an object'} - only a JSON column takes one`)
}

/**
 * A patch, checked whole before any of it is applied.
 *
 * Whole, and that is the point rather than an implementation detail: a patch half-applied and then
 * refused is a row in a state nobody asked for, and the caller's error says nothing about which
 * half. Every field is resolved and every value checked, and only then does anything reach the
 * database.
 *
 * The id is refused explicitly rather than by being left out of the allow-list, because it must be
 * *in* the allow-list for a natural key to be creatable - and the two verbs want opposite things
 * from the same column. A row that renames itself leaves every reference to it dangling, with no
 * error anywhere, which is precisely the failure mode `getMany` answering positionally exists to
 * make visible.
 */
export const patchValues = (resolved: ResolvedWrite, patch: Record<string, unknown>, verb: 'create' | 'update'): Record<string, unknown> => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return refuse(`${verb} takes an object of field names to values`)
    const values: Record<string, unknown> = {}
    for (const [field, value] of Object.entries(patch)) {
        const column = resolved.byName.get(field)
        if (!column) {
            const permitted = resolved.columns.map((one) => one.name)
            return refuse(
                permitted.length
                    ? `${field} is not writable on ${resolved.table.name} - this node writes ${permitted.join(', ')}`
                    : `${field} is not writable on ${resolved.table.name}, which has no writable columns`
            )
        }
        if (verb === 'update' && column.name === resolved.table.id?.name)
            return refuse(`${field} is the id of ${resolved.table.name}: a row cannot be renamed by an update, because every reference taken from the old id would be left pointing at nothing`)
        values[field] = bindValue(column, value)
    }
    if (verb === 'update' && !Object.keys(values).length) return refuse(`update was given no fields to change`)
    if (verb === 'create') {
        // What the database will insist on, said here instead - because the three engines phrase a
        // not-null violation three different ways and none of the three was written for whoever is
        // holding the console.
        const missing = resolved.table.columns
            .filter((column) => !column.nullable && !column.hasDefault && !column.generated && values[column.name] === undefined)
            .map((column) => column.name)
        if (missing.length)
            return refuse(
                `${resolved.table.name} requires ${missing.join(', ')}${missing.some((name) => !resolved.byName.has(name)) ? ', and this node is not permitted to write ' + missing.filter((name) => !resolved.byName.has(name)).join(', ') : ''}`
            )
    }
    return values
}

/**
 * The fields a row's stamp covers: the writable ones, and only those.
 *
 * It falls out of the permission document rather than being a second decision, which is what keeps
 * it explicable. A column nobody may write moving underneath a caller is not a conflict - refusing
 * an edit because a trigger touched `updated_at` is a precondition that fails for a reason nobody
 * can act on, and one of those gets switched off within a week. Two callers writing different
 * permitted fields of the same row *do* conflict, and the second one re-reads and sees what the
 * first did before deciding again, which is the conservative direction and the right one.
 */
export const stampFields = (resolved: ResolvedWrite, row: Record<string, unknown>): readonly (readonly [string, unknown])[] =>
    resolved.columns.map((column) => [column.name, row[column.name]] as const)
