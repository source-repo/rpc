import type { ScopeNode } from '@source-repo/react'

/**
 * The component's resource catalogue. It selects one provider; hierarchy beneath that resource is
 * fetched and folded by ResourceTree in the generic tree-scope-grid.
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
                        title={`show ${key}`}
                    >
                        {node.name}
                    </button>
                    <ScopeTree nodes={node.children} selected={selected} onSelect={onSelect} depth={depth + 1} />
                </div>
            )
        })}
    </>
)
