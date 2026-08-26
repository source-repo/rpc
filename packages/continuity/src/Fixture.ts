import type { RpcMigrationStep, RpcStateSchema } from './index.js'
import { RpcMigrations, RpcStateSchemas } from './index.js'

/**
 * An oven whose state changed shape three times, which is what the suite migrates.
 *
 * A fixture rather than a toy: each version changes in one of the ways that actually happen to a
 * component in service, and each is the smallest change that produces a different *kind* of
 * outcome. A rename the old state fully determines. A new field it does not, which somebody had to
 * decide. And a field nobody can decide, which has to refuse.
 */

/** v1: what the first revision held. */
export interface OvenV1 {
    setpoint: number
    mode: 'idle' | 'heating'
}

/** v2: the setpoint says what it is measured in, and is named for it. */
export interface OvenV2 {
    targetC: number
    mode: 'idle' | 'heating'
    unit: 'C' | 'F'
}

/** v3: one oven became several zones, and the old single value is the first of them. */
export interface OvenV3 {
    zones: { [name: string]: { targetC: number } }
    mode: 'idle' | 'heating'
    unit: 'C' | 'F'
}

/** v4: a calibration date nothing in the old state knows, and nothing may invent. */
export interface OvenV4 extends OvenV3 {
    calibratedAt: string
}

export const OVEN_SCHEMA = 'oven.state'

const mode = { kind: 'union' as const, options: [{ kind: 'literal' as const, value: 'idle' }, { kind: 'literal' as const, value: 'heating' }] }
const unit = { kind: 'union' as const, options: [{ kind: 'literal' as const, value: 'C' }, { kind: 'literal' as const, value: 'F' }] }

export const OVEN_SCHEMAS: readonly RpcStateSchema[] = [
    {
        schemaId: OVEN_SCHEMA,
        version: 1,
        schema: { kind: 'object', fields: { setpoint: { type: { kind: 'number' } }, mode: { type: mode } } }
    },
    {
        schemaId: OVEN_SCHEMA,
        version: 2,
        schema: { kind: 'object', fields: { targetC: { type: { kind: 'number' } }, mode: { type: mode }, unit: { type: unit } } }
    },
    {
        schemaId: OVEN_SCHEMA,
        version: 3,
        schema: {
            kind: 'object',
            fields: {
                zones: { type: { kind: 'record', values: { kind: 'object', fields: { targetC: { type: { kind: 'number' } } } } } },
                mode: { type: mode },
                unit: { type: unit }
            }
        }
    },
    {
        schemaId: OVEN_SCHEMA,
        version: 4,
        schema: {
            kind: 'object',
            fields: {
                zones: { type: { kind: 'record', values: { kind: 'object', fields: { targetC: { type: { kind: 'number' } } } } } },
                mode: { type: mode },
                unit: { type: unit },
                calibratedAt: { type: { kind: 'string' } }
            }
        }
    }
]

/** v1 → v2. A rename the old state fully determines, and one value it does not. */
export const OVEN_1_TO_2: RpcMigrationStep<OvenV1, OvenV2> = {
    id: 'oven.state/1-2/setpoint-is-celsius',
    schemaId: OVEN_SCHEMA,
    from: 1,
    approval: { by: 'process engineering', reference: 'PR #412' },
    apply(state, say) {
        say.transformed('targetC')
        // Every oven in service was commissioned in Celsius; the field was added because a customer
        // asked for Fahrenheit on a *screen*, not because any of them held Fahrenheit values.
        say.defaulted('unit', 'C', 'every oven in service at v1 was commissioned in Celsius; the unit was added for display, not because any stored value was Fahrenheit')
        return { targetC: state.setpoint, mode: state.mode, unit: 'C' }
    }
}

/** v2 → v3. Total: the single setpoint is the first zone's, which is what the split means. */
export const OVEN_2_TO_3: RpcMigrationStep<OvenV2, OvenV3> = {
    id: 'oven.state/2-3/one-zone-becomes-many',
    schemaId: OVEN_SCHEMA,
    from: 2,
    approval: { by: 'process engineering', reference: 'PR #488' },
    apply(state, say) {
        say.transformed('zones.main.targetC')
        return { zones: { main: { targetC: state.targetC } }, mode: state.mode, unit: state.unit }
    }
}

/** v3 → v4. Impossible: nothing in the old state knows when the oven was calibrated. */
export const OVEN_3_TO_4: RpcMigrationStep<OvenV3, OvenV4> = {
    id: 'oven.state/3-4/calibration-date',
    schemaId: OVEN_SCHEMA,
    from: 3,
    approval: { by: 'process engineering', reference: 'PR #501' },
    apply(state, say) {
        // Not defaulted to "now", which is what the shape of the field invites. A calibration date
        // is a claim about when somebody put an instrument on the machine, and inventing one would
        // put a plant back into service against a certificate that does not exist.
        say.impossible('calibratedAt', 'no v3 state records when the oven was calibrated, and a date is a claim about work somebody did rather than a value with a sensible default')
        return { ...state, calibratedAt: '' }
    }
}

/** The registries a suite or an application assembles. Awaited, because a schema hashes itself. */
export const ovenSchemas = async (upTo = 4): Promise<RpcStateSchemas> => {
    const schemas = new RpcStateSchemas()
    for (const schema of OVEN_SCHEMAS.filter((one) => one.version <= upTo)) await schemas.register(schema)
    return schemas
}

export const ovenMigrations = (): RpcMigrations =>
    new RpcMigrations()
        .register(OVEN_1_TO_2 as RpcMigrationStep)
        .register(OVEN_2_TO_3 as RpcMigrationStep)
        .register(OVEN_3_TO_4 as RpcMigrationStep)
