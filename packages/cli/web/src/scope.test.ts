import { describe, expect, it } from 'vitest'
import { actionsFor, leavesUnder, scopeTree, typeAt, type ScopeNode } from './scope'
import type { DescribedComponent, TypeNode } from './types'

/**
 * The scope walk, tested against contracts rather than against data - which is the whole point of
 * it. Every case here builds a `describe()` shape and asserts what the tree and the grid make of
 * it, and none of them has a value in it anywhere, because the tree is drawn before any value
 * exists and would be worth nothing if that stopped being true.
 */

const reading: TypeNode = {
    kind: 'object',
    fields: { value: { type: { kind: 'number' } }, unit: { type: { kind: 'string' } }, quality: { type: { kind: 'string' } } }
}

/** The oven from the issue: a few typed fields, nested zones, and three hundred tags in a record. */
const oven: DescribedComponent = {
    subscribers: 0,
    props: { kind: 'object', fields: { name: { type: { kind: 'string' } }, tagCount: { type: { kind: 'number' } } } },
    state: {
        kind: 'object',
        fields: {
            setpoint: { type: { kind: 'number' } },
            mode: { type: { kind: 'union', options: [{ kind: 'literal', value: 'idle' }, { kind: 'literal', value: 'heating' }] } },
            zones: { type: { kind: 'object', fields: { top: { type: reading }, bottom: { type: reading } } } },
            readings: { type: { kind: 'object', fields: { last: { type: reading }, window: { type: { kind: 'tuple', items: [{ kind: 'number' }, { kind: 'number' }] } } } } },
            tags: { type: { kind: 'record', values: { kind: 'ref', name: 'Reading' } } }
        }
    }
}

const types = { Reading: reading }

/** Paths only, since the shape of the tree is what every one of these is about. */
const paths = (nodes: ScopeNode[]): string[] => nodes.flatMap((node) => [node.path.join('.'), ...paths(node.children)])

const leafNames = (component: DescribedComponent, at: string[], named?: { [name: string]: TypeNode }) =>
    leavesUnder(typeAt(component, at, named), at, named).map((leaf) => `${leaf.path.join('.')}${leaf.collection ? ' []' : ''}`)

describe('the scope tree', () => {
    it('holds typed containers and nothing else', () => {
        expect(paths(scopeTree(oven, types))).toEqual(['props', 'state', 'state.zones', 'state.readings', 'state.readings.window'])
    })

    it('leaves a record out entirely, however much is behind it', () => {
        // The rule the whole design rests on: `tags` is where type ends and data begins, so it is a
        // grid row and never a node. A tree that expanded it would cost a request to draw, and the
        // invariant is that the tree costs nothing on the wire, ever.
        expect(paths(scopeTree(oven, types))).not.toContain('state.tags')
    })

    it('treats a process value as a leaf despite it being an object', () => {
        // Three fields to a schema, one thing to a reader. `zones` is a node with no children
        // rather than a node with two, because a reading is what the operator is looking at.
        const zones = scopeTree(oven, types)[1].children.find((node) => node.name === 'zones')
        expect(zones?.children).toEqual([])
    })

    it('omits a root the contract does not publish, rather than showing an empty one', () => {
        // A component serving no schema has no scope to show. An empty `props` node would claim it
        // had one and that it was empty, which is a different and wrong statement.
        expect(paths(scopeTree({ subscribers: 0, state: { kind: 'object', fields: {} } }))).toEqual(['state'])
    })
})

describe('the leaves under a node', () => {
    it('are everything beneath it, recursively, all the way down', () => {
        // Recursive by design: the tree is a filter, not a navigator. Selecting `state` lists the
        // whole state, and a grid showing only direct children would need as many clicks as the
        // state has depth.
        expect(leafNames(oven, ['state'], types)).toEqual([
            'state.setpoint',
            'state.mode',
            'state.zones.top',
            'state.zones.bottom',
            'state.readings.last',
            'state.readings.window.0',
            'state.readings.window.1',
            'state.tags []'
        ])
    })

    it('narrow to the selection', () => {
        expect(leafNames(oven, ['state', 'zones'], types)).toEqual(['state.zones.top', 'state.zones.bottom'])
    })

    it('report a record as one collection rather than expanding it', () => {
        // Its entries are most of what the operator came to see, and they arrive by asking - a
        // getList naming this path - rather than by walking a type that cannot know the keys.
        const [tags] = leavesUnder(typeAt(oven, ['state', 'tags'], types), ['state', 'tags'], types)
        expect(tags).toEqual({ path: ['state', 'tags'], type: { kind: 'record', values: { kind: 'ref', name: 'Reading' } }, collection: true })
    })
})

describe('a self-referential contract', () => {
    // `interface Node { child: Node }` is how a hierarchy gets written, and a naive walk over it
    // does not terminate. Stopping is also the right answer rather than only the safe one: a type
    // that contains itself has a depth decided by data, which is exactly what this tree must not
    // know. What hangs beneath it is a data tree, fetched lazily, and not this one.
    const recursive: DescribedComponent = { subscribers: 0, state: { kind: 'object', fields: { root: { type: { kind: 'ref', name: 'Node' } } } } }
    const recursiveTypes: { [name: string]: TypeNode } = {
        Node: { kind: 'object', fields: { name: { type: { kind: 'string' } }, child: { type: { kind: 'ref', name: 'Node' } } } }
    }

    it('terminates, and stops the tree where the type turns back on itself', () => {
        expect(paths(scopeTree(recursive, recursiveTypes))).toEqual(['state', 'state.root'])
    })

    it('terminates in the grid too, with the repeat as a leaf', () => {
        expect(leafNames(recursive, ['state'], recursiveTypes)).toEqual(['state.root.name', 'state.root.child'])
    })
})

describe('a component that serves resources of its own', () => {
    // The Source Relational shape: nothing about `customers` is in props or state, and nothing
    // could be, because which tables a store holds is data. So it is declared, and the tree carries
    // it beside props and state rather than pretending it is part of either.
    const store: DescribedComponent = {
        subscribers: 0,
        state: { kind: 'object', fields: { connected: { type: { kind: 'boolean' } } } },
        resources: [
            { path: ['customers'], verbs: ['getList'], label: 'Customers', row: { kind: 'object', fields: { name: { type: { kind: 'string' } } } } },
            { path: ['audit'], verbs: ['getManyReference'] }
        ]
    }

    it('gives each one a root of its own, labelled as the component named it', () => {
        expect(paths(scopeTree(store))).toEqual(['state', 'customers'])
    })

    it('offers only what the resource says it answers', () => {
        // `audit` claims getManyReference and nothing this grid can do, so it is not offered at all.
        // A node that appeared and then refused every selection would be worse than one that is not
        // there, and the verb list exists precisely so a viewer can tell.
        expect(paths(scopeTree(store))).not.toContain('audit')
    })

    it('reads as a record of its row type, so the grid needs to know nothing about resources', () => {
        // Which is what makes selecting it work without a line of special-casing: the grid finds a
        // collection under the selection and pages it, exactly as it does for a record in state.
        const [leaf] = leavesUnder(typeAt(store, ['customers']), ['customers'])
        expect(leaf.collection).toBe(true)
        expect(leaf.path).toEqual(['customers'])
        expect(typeAt(store, ['customers'])).toEqual({ kind: 'record', values: { kind: 'object', fields: { name: { type: { kind: 'string' } } } } })
    })

    it('falls back to an unknown row rather than refusing to draw one', () => {
        // A component may serve a collection it cannot describe the rows of - a heterogeneous
        // document store most obviously - and a grid drawn from the values is the fallback that
        // already exists for context values.
        const untyped: DescribedComponent = { subscribers: 0, resources: [{ path: ['blobs'], verbs: ['getList'] }] }
        expect(typeAt(untyped, ['blobs'])).toEqual({ kind: 'record', values: { kind: 'any' } })
    })
})

describe('typeAt', () => {
    it('resolves a selection through refs', () => {
        expect(typeAt(oven, ['state', 'zones', 'top'], types)).toEqual(reading)
    })

    it('answers nothing for a path the contract does not describe', () => {
        expect(typeAt(oven, ['state', 'nope'], types)).toBeUndefined()
        expect(typeAt(oven, ['nowhere'], types)).toBeUndefined()
    })

    it('will not walk into a record, because its keys are not in the contract', () => {
        expect(typeAt(oven, ['state', 'tags', 'tag.017'], types)).toBeUndefined()
    })
})

describe('what may be done to a row', () => {
    const component: DescribedComponent = {
        subscribers: 0,
        resources: [
            {
                path: ['deadLetters'],
                verbs: ['getList'],
                actions: [
                    { method: 'retryDeadLetter', label: 'retry' },
                    { method: 'discardDeadLetter', confirm: true },
                    { method: 'nonesuch', label: 'typo' }
                ]
            }
        ]
    }
    const methods = [{ name: 'retryDeadLetter' }, { name: 'discardDeadLetter' }]

    it('offers only actions whose method the contract actually publishes', () => {
        // A typo in a declaration would otherwise draw a control that always fails, which is worse
        // than no control: an operator finds out by trying it on a plant.
        expect(actionsFor(component, ['deadLetters'], methods)?.map((action) => action.method)).toEqual(['retryDeadLetter', 'discardDeadLetter'])
    })

    it("carries the author's own judgement about which are final", () => {
        expect(actionsFor(component, ['deadLetters'], methods)?.[1].confirm).toBe(true)
    })

    it('has nothing to say about a resource it does not name, or a path that is not one', () => {
        expect(actionsFor(component, ['state', 'tags'], methods)).toBeUndefined()
        expect(actionsFor({ subscribers: 0 }, ['deadLetters'], methods)).toBeUndefined()
    })
})
