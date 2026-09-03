import EventEmitter from "events";
import { componentSnapshotEvent, RpcComponent } from "./Component.js";
import {
  describedResources,
  servesDataResources,
  type RpcDataResource,
} from "./DataProvider.js";
import type { RpcWritableResource } from "./DataWrites.js";
import {
  currentElevations,
  declaresElevation,
  type RpcElevation,
} from "./Elevation.js";
import { rpc, rpcNamespace, type RpcEffect } from "./Expose.js";
import type { RpcServerHandler } from "./RpcServerHandler.js";
import {
  SCHEMA_VERSION,
  type MethodSchema,
  type NamespaceSchema,
  type RpcSchema,
  type TypeNode,
} from "./Schema.js";
import {
  HOST_ROOT,
  type RpcRef,
  type RpcTopologyCapabilities,
  type RpcTopologyMutation,
  type RpcTopologyPatch,
  type RpcTopologyRecord,
} from "./Topology.js";
import type { RpcMethodSemantics } from "./Messages.js";
// Extracted from this file by `npm run contract` in the CLI package and committed, so building
// msgrpc never needs the extractor that reads it. A test there asserts it still matches this source.
import extracted from "./Introspection.types.json" with { type: "json" };

/**
 * What a server can say about itself.
 *
 * Deliberately msgrpc's own shape rather than a borrowed one. OpenAPI is HTTP-shaped and has no
 * good way to describe a server pushing events; AsyncAPI models everything as a channel, which
 * fights an RPC surface. Both would mean describing this system in someone else's concepts to
 * satisfy a viewer we would then still want to replace.
 */

export interface DescribedMethod {
  name: string;
  /** Present when a schema describes this method; absent when nothing does. */
  params?: TypeNode[];
  /** Positionally matching `params`, when the schema carries them. */
  paramNames?: string[];
  rest?: TypeNode;
  returns?: TypeNode;
  /**
   * What calling it does to the world, when the method says: `query`, `idempotent-command` or
   * `non-repeatable-command`. Absent means it does not say, which a person reading a list of
   * methods should treat as "ask before pressing this".
   */
  semantics?: RpcMethodSemantics;
  /**
   * What kind of power calling this exercises. Always present: this is the effect the server will
   * enforce, which is the declared one or its conservative default - a consumer deciding what an
   * AI principal may call should not have to reimplement the defaulting rule.
   */
  effect?: RpcEffect;
  /**
   * Which path in the component's `state` calling this sets, when the method says - a field, a
   * dot path, or `*` for a method that takes the path as an argument. This is what lets a console
   * offer to change a value without inferring from a method's name which value that is; absent
   * means nothing should be drawn from it.
   *
   * What the server will honour, not merely what the source declared: `*` appears only on a host
   * that opted in with `allowStatePathWrites`, since a claim the next call would refuse is not a
   * claim. A per-field declaration is never gated and always appears.
   */
  sets?: string;
  /** True when only the peer holding the component's authority may call it. */
  requiresAuthority?: boolean;
}

export interface DescribedEvent {
  name: string;
  params?: TypeNode[];
  /** How many peers currently hold a subscription to it. */
  subscribers: number;
}

/**
 * An observable component's shape, as a peer may see it. Types come from the schema when one is
 * loaded; the subscriber count is live either way. Structure only - the current snapshot is served
 * exclusively to authorized subscribers, and describing a thing must never leak its values.
 */
export interface DescribedComponent {
  props?: TypeNode;
  state?: TypeNode;
  /** How many peers currently observe this component. */
  subscribers: number;
  /**
   * Collections this component serves that its contract cannot describe - a table, a document
   * collection, a queue - each with the shape of a row and the verbs it answers.
   *
   * Absent from an ordinary component, and that is not the same as empty: a record in `props` or
   * `state` is addressable without appearing here, because the published type already describes
   * it and a viewer finds it by reading the contract. This carries the other kind, where **what
   * resources exist is itself data** and only the component knows.
   *
   * Read at describe time rather than fixed at exposure, so a store that gains a table says so on
   * the next describe rather than at the next restart.
   */
  resources?: readonly RpcDataResource[];
}

/**
 * Where a namespace sits in the two structures, as its home host declares it. Refs and epochs,
 * never paths: paths are derived display data, and a reader derives them by looking records up.
 */
export interface DescribedTopology {
  parent: RpcRef | null;
  owner: RpcRef | null;
  parentEpoch: string;
  ownerEpoch: string;
  label?: string;
}

export interface DescribedNamespace {
  name: string;
  version?: string;
  /** Class the exposed instance came from, which is usually what a person is looking for. */
  className?: string;
  /** True when the instance was created at runtime through createRpcInstance. */
  created: boolean;
  /** True when the instance can emit events at all. */
  emitter: boolean;
  /** True when calls into this instance run one at a time rather than side by side. */
  serialised?: boolean;
  /** Present when the instance is an observable component. */
  component?: DescribedComponent;
  /** Present when this host declared where the instance sits. */
  topology?: DescribedTopology;
  /**
   * Package-qualified capability names, read from the extracted schema and never from
   * constructor.name - a bundler mangles the latter, and schema data survives minification.
   * Discoverable therefore means having an extracted contract, as a rule rather than a surprise.
   */
  capabilities?: string[];
  methods: DescribedMethod[];
  events: DescribedEvent[];
}

export interface ServerDescription {
  /** Name this server is addressed by. */
  name: string;
  /** Contract version of the schema as a whole, when one is loaded. */
  version?: string;
  /** True when arguments are being checked, which tells a caller how much to trust the types. */
  validating: boolean;
  namespaces: DescribedNamespace[];
  /**
   * What this peer can currently do that is dangerous, announced rather than asked for.
   *
   * Absent means nothing is elevated, which is the ordinary state of a plant node and should stay
   * boring. Present means a console can say so without calling anything - and an entry with no
   * `until` is the one worth drawing attention to, because nothing will close it by itself.
   *
   * Collected from the exposed instances that declare themselves elevations, plus whatever the
   * host declared directly. Nothing here grants anything; `authorize()` and the capability's own
   * allow-list decide, and would decide the same with this field removed.
   */
  elevated?: RpcElevation[];
  /**
   * This host in the physical structure: its effective root - synthetic when nothing was
   * registered - the root's cross-host parent when one is declared, the deployment's place ids,
   * and which topology guarantees are actually active here. Stated, never implied.
   */
  host?: {
    root: RpcRef;
    parent: RpcRef | null;
    /** The root's logical owner, when one is declared - the other axis a peer tree can group by. */
    owner?: RpcRef | null;
    place?: string[];
    label?: string;
    capabilities: RpcTopologyCapabilities;
  };
  /** Named types the described methods refer to. */
  types?: { [name: string]: TypeNode };
}

/**
 * The schema format has one type map shared by every namespace, so a library adding types to a
 * user's schema has to stay out of their names - a plant defining its own `TypeNode` would
 * otherwise find describe() described against it. Everything here moves under a prefix that no
 * extracted type can collide with, since `.` is not part of an identifier.
 */
const PREFIX = "msgrpc.";

const prefixRefs = (node: TypeNode): TypeNode => {
  switch (node.kind) {
    case "ref":
      return { ...node, name: PREFIX + node.name };
    case "array":
      return { ...node, items: prefixRefs(node.items) };
    case "record":
      return { ...node, values: prefixRefs(node.values) };
    case "tuple":
      return { ...node, items: node.items.map(prefixRefs) };
    case "union":
      return { ...node, options: node.options.map(prefixRefs) };
    case "object":
      return {
        ...node,
        fields: Object.fromEntries(
          Object.entries(node.fields).map(([name, field]) => [
            name,
            { ...field, type: prefixRefs(field.type) },
          ]),
        ),
      };
    default:
      return node;
  }
};

const prefixMethod = (method: MethodSchema): MethodSchema => ({
  ...method,
  params: method.params.map(prefixRefs),
  ...(method.rest ? { rest: prefixRefs(method.rest) } : {}),
  ...(method.returns ? { returns: prefixRefs(method.returns) } : {}),
});

const source = extracted as RpcSchema;

/** What this namespace offers, ready to merge into whatever schema a server was given. */
export const introspectionSchema: {
  namespace: NamespaceSchema;
  types: { [name: string]: TypeNode };
} = {
  namespace: {
    ...source.namespaces.msgrpc,
    methods: Object.fromEntries(
      Object.entries(source.namespaces.msgrpc.methods).map(([name, method]) => [
        name,
        prefixMethod(method),
      ]),
    ),
    ...(source.namespaces.msgrpc.events
      ? {
          events: Object.fromEntries(
            Object.entries(source.namespaces.msgrpc.events).map(
              ([name, event]) => [
                name,
                { params: event.params.map(prefixRefs) },
              ],
            ),
          ),
        }
      : {}),
  },
  types: Object.fromEntries(
    Object.entries(source.types ?? {}).map(([name, type]) => [
      PREFIX + name,
      prefixRefs(type),
    ]),
  ),
};

/**
 * Adds the `msgrpc` namespace to a server's schema, so describe() is described like anything else -
 * and so `validation: 'required'` does not refuse the one call a peer makes to find out what is
 * here, which it did before this existed.
 *
 * A server given no schema still gets this one. That does not turn checking on: validation defaults
 * from the schema the *caller* passed, so an undescribed server stays undescribed and only reports
 * its own introspection honestly.
 *
 * A user schema already defining `msgrpc` wins untouched. It is the contract that server actually
 * serves, and overwriting it would describe the server as something it is not.
 */
export const withIntrospection = (schema: RpcSchema | undefined): RpcSchema => {
  if (schema?.namespaces.msgrpc) return schema;
  return {
    schema: SCHEMA_VERSION,
    ...schema,
    types: { ...schema?.types, ...introspectionSchema.types },
    namespaces: {
      ...schema?.namespaces,
      msgrpc: introspectionSchema.namespace,
    },
  };
};

/**
 * Exposed under the namespace `msgrpc` when RpcServer is constructed with exposeIntrospection.
 *
 * Off by default, and it goes through the ordinary dispatch path, so authorize() sees it as a call
 * on `msgrpc.describe` and can restrict it. Listing every class, method and live instance is
 * reconnaissance, and on a plant network instance names tend to encode plant structure.
 */
@rpcNamespace("msgrpc")
export class Introspection {
  constructor(private handler: RpcServerHandler) {}

  /**
   * This host's topology records whole - what a console needs to draw the trees without asking
   * per namespace. Structure only, like describe(): refs, epochs and labels, never process data.
   * Rides the same opt-in and the same authorize() gate as describe(), because listing where
   * everything sits is reconnaissance of exactly the same order as listing what everything does.
   */
  @rpc({ semantics: "query" })
  async topology(): Promise<
    | {
        records: RpcTopologyRecord[];
        place?: string[];
        capabilities: RpcTopologyCapabilities;
      }
    | undefined
  > {
    const held = this.handler.hostTopology;
    if (!held) return undefined;
    return {
      records: held.all(),
      ...(held.place ? { place: held.place } : {}),
      capabilities: held.capabilities(),
    };
  }

  /**
   * Remote topology mutation, and its authorization is the design rather than a paragraph on it:
   * refused wholesale unless the server opted in with `topology.allowRemoteMutation` - a
   * deployment that never enables it has no new surface at all - and when enabled, every call
   * still passes authorize() as `msgrpc.updateTopology` with the instance and patch in params,
   * which is where a plant decides who may restructure it. The CAS expectedVersion is mandatory:
   * there is no blind write, so two administrators cannot silently overwrite each other, and a
   * retry after an uncertain outcome fails the version check instead of applying twice - which
   * is what makes `idempotent-command` the honest declaration.
   */
  @rpc({ semantics: "idempotent-command" })
  async updateTopology(
    instance: string,
    patch: RpcTopologyPatch,
    mutation: RpcTopologyMutation,
  ): Promise<RpcTopologyRecord> {
    const held = this.handler.hostTopology;
    if (!held) throw new Error("this host keeps no topology records");
    if (!this.handler.allowTopologyMutation)
      throw new Error(
        "this host does not accept remote topology mutation - it is enabled with topology.allowRemoteMutation, and gated by authorize() like any call",
      );
    return instance === HOST_ROOT
      ? held.updateHost(patch, mutation)
      : held.update(instance, patch, mutation);
  }

  /**
   * Where one event's emission counter stands, so a watcher polling in windows can tell "saw
   * nothing and missed nothing" from "saw nothing but three fired" - which are different
   * answers, and only the first was ever available before.
   *
   * The vocabulary is the component channel's: `epoch` names this server incarnation and `seq`
   * only orders within it, so a cursor held across a restart compares epochs, finds them
   * different, and reports "cannot know" rather than a guess. `since` is when counting began -
   * for an event the schema declares that is expose time, and for an ad-hoc one it is the first
   * subscription or the first of these calls, whichever came sooner; asking here starts the
   * counter, so the *next* window has ground to stand on either way. An event nothing can track
   * - no such namespace, or an instance that cannot emit - answers seq: null, plainly.
   *
   * Rides the same opt-in and the same authorize() gate as describe(), because how often a
   * device fires an alarm is process information of exactly the same order as what it serves.
   */
  @rpc({ semantics: "query" })
  async eventCursor(
    namespace: string,
    event: string,
  ): Promise<{ epoch: string; seq: number | null; since?: number }> {
    const known = this.handler.eventSequenceOf(namespace, event);
    if (known === undefined) this.handler.trackEvent(namespace, event);
    const seq = this.handler.eventSequenceOf(namespace, event);
    return {
      epoch: this.handler.epoch,
      seq: seq ?? null,
      ...(seq !== undefined
        ? { since: this.handler.eventTrackedSince(namespace, event) }
        : {}),
    };
  }

  /**
   * Declared a query like everything else on this class, and it was the one that was not.
   *
   * Describing a server reads its own maps and changes nothing, so `query` is what it always was.
   * But an undeclared method defaults to `operate`, and that default reached further than it
   * looks: it made introspection a *write* in the eyes of the AI boundary, so a principal badged
   * to observe could not ask a node what it serves - the call every console and every model
   * begins with, refused for exercising a power it does not exercise.
   */
  @rpc({ semantics: "query" })
  async describe(): Promise<ServerDescription> {
    const manage = this.handler.manageRpc;
    const schema = this.handler.schema;

    /**
     * What a namespace's sibling write surface accepts, where it has one.
     *
     * The `<namespace>.write` convention predates this and is the console's; reading it here is
     * what lets one declaration answer "what can I do with this". The alternative, which this
     * replaces, was every caller opening a second namespace and joining the two lists by name.
     *
     * Refusals are swallowed on purpose. A write surface that will not answer - unauthorized, or
     * a store that has gone away - must not take the whole description down with it: the read
     * half is still true and is most of what a caller came for. The resource then reports the
     * verbs it reads with, which is exactly what it reported before any of this existed.
     */
    const writesFor = async (
      name: string,
    ): Promise<readonly RpcWritableResource[] | undefined> => {
      const sibling = manage.namespaces.get(`${name}.write`)?.instance as
        { writable?(): Promise<readonly RpcWritableResource[]> } | undefined;
      if (typeof sibling?.writable !== "function") return undefined;
      try {
        return await sibling.writable();
      } catch {
        return undefined;
      }
    };

    const namespaces: DescribedNamespace[] = (
      await Promise.all(
        [...manage.namespaces].map(async ([name, held]) => {
          const instance = held.instance;
          if (!instance) return [];
          const described = schema?.namespaces[name];
          const methodNames = [
            ...(manage.findNameSpaceMethodMap(name)?.keys() ?? []),
          ].sort();
          const methods: DescribedMethod[] = methodNames.map((method) => {
            const signature = described?.methods[method];
            const semantics = this.handler.semanticsOf({ path: name, method });
            const sets = this.handler.publishedSetsOf({ path: name, method });
            return {
              name: method,
              ...(signature
                ? {
                    params: signature.params,
                    paramNames: signature.paramNames,
                    rest: signature.rest,
                    returns: signature.returns,
                  }
                : {}),
              ...(semantics ? { semantics } : {}),
              effect: this.handler.effectOf({ path: name, method }),
              ...(sets !== undefined ? { sets } : {}),
              ...(held.authority?.has(method)
                ? { requiresAuthority: true }
                : {}),
            };
          });

          // Declared events plus any a peer is currently subscribed to, since a server without a
          // schema still knows what has been subscribed.
          const eventNames = new Set(Object.keys(described?.events ?? {}));
          for (const proxy of this.handler.eventProxies.values())
            if (proxy.instanceName === name) eventNames.add(proxy.event);
          // The component snapshot channel is the library's, not the contract's: listing it would
          // invite subscribing to it as an ordinary event, which component() already does properly.
          eventNames.delete(componentSnapshotEvent);
          const events: DescribedEvent[] = [...eventNames]
            .sort()
            .map((event) => ({
              name: event,
              ...(described?.events?.[event]
                ? { params: described.events[event].params }
                : {}),
              subscribers: [...this.handler.eventProxies.values()].filter(
                (proxy) => proxy.instanceName === name && proxy.event === event,
              ).length,
            }));

          const record = this.handler.hostTopology?.get(name);
          const topology: DescribedTopology | undefined = record
            ? {
                parent: record.parent,
                owner: record.owner,
                parentEpoch: record.parentEpoch,
                ownerEpoch: record.ownerEpoch,
                ...(record.label !== undefined ? { label: record.label } : {}),
              }
            : undefined;
          const execution = held.execution;
          // Structure and a live count, never the snapshot itself: current values go only to
          // authorized subscribers, and describe() must not become the unauthorized way in.
          const component: DescribedComponent | undefined =
            instance instanceof RpcComponent
              ? {
                  ...(described?.component
                    ? {
                        props: described.component.props,
                        state: described.component.state,
                      }
                    : {}),
                  subscribers: [...this.handler.eventProxies.values()].filter(
                    (proxy) =>
                      proxy.instanceName === name &&
                      proxy.event === componentSnapshotEvent,
                  ).length,
                  // Structure, like everything else here: what collections exist and the
                  // shape of a row, never a row. A store that gained a table since the last
                  // describe says so now, which is why this is read rather than remembered.
                  ...(servesDataResources(instance)
                    ? {
                        resources: describedResources(
                          instance,
                          name,
                          this.handler.schema?.types,
                          await writesFor(name),
                        ),
                      }
                    : {}),
                }
              : undefined;
          return {
            name,
            ...(described?.version ? { version: described.version } : {}),
            // Worth reporting because it changes what a caller should expect: on a serialised
            // instance a slow method delays every other call into it, and that is a property of
            // the server rather than of the network.
            ...(execution && execution !== "parallel"
              ? { serialised: true }
              : {}),
            className: instance.constructor?.name,
            created: held.created === true,
            emitter: instance instanceof EventEmitter,
            ...(component ? { component } : {}),
            ...(topology ? { topology } : {}),
            ...(described?.capabilities
              ? { capabilities: described.capabilities }
              : {}),
            methods,
            events,
          };
        }),
      )
    ).flat();

    const hostTopology = this.handler.hostTopology;
    const root = hostTopology?.get(HOST_ROOT);
    const elevated = currentElevations([
      ...[...manage.namespaces.values()]
        .map((held) => held.instance)
        .filter(
          (instance): instance is object =>
            Boolean(instance) && declaresElevation(instance as object),
        )
        .map((instance) =>
          (instance as { elevation(): RpcElevation | undefined }).elevation(),
        )
        .filter((one): one is RpcElevation => Boolean(one)),
      ...this.handler.declaredElevations,
    ]);
    return {
      name: this.handler.name,
      ...(schema?.version ? { version: schema.version } : {}),
      validating: !!schema && this.handler.validation !== "off",
      namespaces: namespaces.sort((a, b) => a.name.localeCompare(b.name)),
      // Gathered from what is exposed rather than from what somebody remembered to declare:
      // composing a dangerous capability into a host is what makes the host dangerous, so
      // that act is what announces it. Omitted entirely when nothing is elevated, so the
      // ordinary state of a plant node stays boring and the field's presence means something.
      ...(elevated.length ? { elevated } : {}),
      ...(hostTopology && root
        ? {
            host: {
              root: root.ref,
              parent: root.parent,
              ...(root.owner ? { owner: root.owner } : {}),
              ...(hostTopology.place ? { place: hostTopology.place } : {}),
              ...(root.label !== undefined ? { label: root.label } : {}),
              capabilities: hostTopology.capabilities(),
            },
          }
        : {}),
      ...(schema?.types ? { types: schema.types } : {}),
    };
  }
}

/**
 * FNV-1a over the text, 64 bits as 16 hex characters. Not cryptographic and deliberately so: the
 * hash is compared for equality by caches deciding whether to re-describe, nothing is keyed or
 * signed by it, and this runs in a browser page hosting services, where node:crypto is not there
 * to lean on. A collision costs one cache a missed invalidation, the same cost the cache paid for
 * every change before the hash existed.
 */
const fnv1a64 = (text: string) => {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
};

/**
 * What a server's exposed surface hashes to - the invalidation signal presence carries so caches
 * notice a peer changed shape (see PresenceAnnouncement.shape).
 *
 * Deliberately a projection of describe(), not describe() itself: subscriber counts and topology
 * epochs move while the surface stands still, and a hash over them would invalidate every cache
 * on every subscribe. What goes in is what a cached description answers questions about -
 * namespaces, methods with their signatures and semantics, declared events, versions,
 * capabilities, component structure. Sorted where the source is a map, so exposure order does not
 * masquerade as change.
 */
export const surfaceShape = (handler: RpcServerHandler): string => {
  const manage = handler.manageRpc;
  const schema = handler.schema;
  const namespaces = [...manage.namespaces]
    .filter(([, held]) => held.instance)
    .map(([name]) => name)
    .sort()
    .map((name) => {
      const described = schema?.namespaces[name];
      const methods = [...(manage.findNameSpaceMethodMap(name)?.keys() ?? [])]
        .sort()
        .map((method) => {
          const semantics = handler.semanticsOf({ path: name, method });
          // In the hash because a console caches descriptions and draws editors from `sets`:
          // a peer that redeploys having moved which field a method commands must invalidate
          // that cache, or the page offers to write somewhere the device no longer writes.
          const sets = handler.publishedSetsOf({ path: name, method });
          return {
            name: method,
            ...(described?.methods[method]
              ? { signature: described.methods[method] }
              : {}),
            ...(semantics ? { semantics } : {}),
            effect: handler.effectOf({ path: name, method }),
            ...(sets !== undefined ? { sets } : {}),
            ...(manage.at(name)?.authority?.has(method)
              ? { requiresAuthority: true }
              : {}),
          };
        });
      return {
        name,
        ...(described?.version ? { version: described.version } : {}),
        className: manage.instanceAt(name)?.constructor?.name,
        methods,
        events: Object.keys(described?.events ?? {}).sort(),
        ...(described?.capabilities
          ? { capabilities: [...described.capabilities].sort() }
          : {}),
        ...(described?.component ? { component: described.component } : {}),
      };
    });
  return fnv1a64(JSON.stringify(namespaces));
};
