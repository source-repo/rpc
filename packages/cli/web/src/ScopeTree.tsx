import type { ScopeNode } from './scope'

/**
 * The left pane: scope, drawn entirely from the contract.
 *
 * Every node here is a typed container the published `props` and `state` interfaces name, so the
 * whole tree exists before a single value arrives and costs nothing on the wire however much data
 * sits behind it. Nothing in this component fetches anything, and nothing in it may ever start to -
 * a node whose children came from a request would end that invariant silently, and the tree would
 * begin costing exactly what it is here to avoid.
 *
 * **It filters rather than navigates.** Selecting a node shows every value beneath it recursively,
 * all the way down, so `state` lists the whole state and `state.zones` narrows to the zones. A tree
 * that showed only direct children would need as many clicks as the state has depth, which is the
 * arrangement this replaced.
 *
 * Drawn fully expanded on purpose. The tree is bounded by the contract - that is the whole reason
 * records are not in it - so there is nothing here to collapse away, and a disclosure state would be
 * one more thing to keep in sync for no gain.
 */
export const ScopeTree = ({ nodes, selected, onSelect, depth = 0 }: { nodes: ScopeNode[]; selected: string; onSelect: (path: string[]) => void; depth?: number }) => (
    <>
        {nodes.map((node) => {
            const key = node.path.join('.')
            return (
                <div key={key} className="scope-node">
                    <button
                        className={`scope-name mono${key === selected ? ' on' : ''}`}
                        style={{ paddingLeft: `${depth * 12}px` }}
                        onClick={() => onSelect(node.path)}
                        title={`show every value under ${key}`}
                    >
                        {node.name}
                    </button>
                    <ScopeTree nodes={node.children} selected={selected} onSelect={onSelect} depth={depth + 1} />
                </div>
            )
        })}
    </>
)
