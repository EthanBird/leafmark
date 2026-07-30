import { ChevronRight, FileText, Folder, FolderOpen, MoreHorizontal } from "lucide-react";
import type { MouseEvent } from "react";
import type { TreeNode } from "../types";

interface FileTreeProps {
  nodes: TreeNode[];
  selectedPath: string;
  expanded: Set<string>;
  onOpen: (path: string) => void;
  onToggle: (path: string) => void;
  onMenu: (event: MouseEvent, node: TreeNode) => void;
}

export function FileTree({ nodes, selectedPath, expanded, onOpen, onToggle, onMenu }: FileTreeProps) {
  return (
    <>
      {nodes.map((node) => {
        const directory = node.entry.kind === "directory";
        const open = expanded.has(node.entry.path);
        return (
          <div key={node.entry.path}>
            <div
              className={`tree-row${selectedPath === node.entry.path ? " selected" : ""}`}
              style={{ "--tree-depth": node.entry.depth } as React.CSSProperties}
              role="treeitem"
              aria-selected={selectedPath === node.entry.path}
              aria-expanded={directory ? open : undefined}
              onDoubleClick={() => directory && onToggle(node.entry.path)}
              onContextMenu={(event) => onMenu(event, node)}
            >
              <button
                className="tree-main"
                type="button"
                onClick={() => directory ? onToggle(node.entry.path) : onOpen(node.entry.path)}
                title={node.entry.path}
              >
                <ChevronRight className={`tree-chevron${open ? " open" : ""}${directory ? "" : " hidden"}`} size={13} />
                {directory ? (open ? <FolderOpen size={15} /> : <Folder size={15} />) : <FileText size={14} />}
                <span>{node.entry.name}</span>
              </button>
              <button className="tree-more" type="button" aria-label={`${node.entry.name} 更多操作`} onClick={(event) => onMenu(event, node)}>
                <MoreHorizontal size={14} />
              </button>
            </div>
            {directory && open && node.children.length > 0 && (
              <FileTree nodes={node.children} selectedPath={selectedPath} expanded={expanded} onOpen={onOpen} onToggle={onToggle} onMenu={onMenu} />
            )}
          </div>
        );
      })}
    </>
  );
}
