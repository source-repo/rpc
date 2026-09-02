export { OpcUaAspectProvider, type ChildrenProbe, type OpcUaProviderOptions, type OpcUaProviderProps, type OpcUaProviderState } from './Provider.js'
export { buildDerived, type DerivedAspect, type DerivedIndex, type IndexedNode } from './Derived.js'
export { portableNodeIdFromText, portableNodeIdToText, toSessionNodeId, fromSessionNodeId, type PortableNodeId } from './Identity.js'

/**
 * What this package's methods look like, extracted from the source and committed beside it.
 *
 * A deployment hands this to its `RpcServer` as part of `schema`, and that is what lets a console
 * draw a field per argument instead of `write(…)`. Without it the peer publishes every method's
 * name, semantics and effect - enough to list, not enough to call with anything but a guess - and a
 * row action that needs more than the row has nothing to ask for.
 *
 * Shipped rather than left to each deployment to extract, because the shape is this package's and
 * every deployment would otherwise be extracting the same file from the same source.
 */
export { default as contract } from './Provider.types.json' with { type: 'json' }
