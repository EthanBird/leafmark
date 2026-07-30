import { FileQuestion, Star, Trash2 } from "lucide-react";
import type { ArchiveEntry } from "../types";

interface DocumentLibraryProps {
  entries: ArchiveEntry[];
  selectedId: string;
  emptyTitle: string;
  emptyDetail: string;
  onOpen: (entry: ArchiveEntry) => void;
  onFavorite: (entry: ArchiveEntry, favorite: boolean) => void;
  onRemove: (entry: ArchiveEntry) => void;
}

export function DocumentLibrary({
  entries,
  selectedId,
  emptyTitle,
  emptyDetail,
  onOpen,
  onFavorite,
  onRemove,
}: DocumentLibraryProps) {
  if (!entries.length) {
    return (
      <div className="tree-empty">
        <FileQuestion size={24} />
        <strong>{emptyTitle}</strong>
        <span>{emptyDetail}</span>
      </div>
    );
  }

  return (
    <div className="archive-list" role="list">
      {entries.map((entry) => (
        <div
          className={`archive-row${selectedId === entry.id ? " selected" : ""}`}
          key={entry.id}
          role="listitem"
        >
          <button className="archive-open" type="button" onClick={() => onOpen(entry)}>
            <span className="archive-title">
              <strong>{entry.name}</strong>
              {!entry.sourceExists && <em>保留副本</em>}
            </span>
            <span className="archive-path" title={entry.sourcePath}>{entry.sourcePath}</span>
            <time dateTime={new Date(entry.lastOpenedMs).toISOString()}>
              {formatRecentTime(entry.lastOpenedMs)}
            </time>
          </button>
          <div className="archive-actions">
            <button
              className={entry.favorite ? "favorite" : ""}
              type="button"
              title={entry.favorite ? "取消收藏" : "收藏并保留"}
              onClick={() => onFavorite(entry, !entry.favorite)}
            >
              <Star size={13} fill={entry.favorite ? "currentColor" : "none"} />
            </button>
            {!entry.favorite && (
              <button type="button" title="移除历史记录和保留副本" onClick={() => onRemove(entry)}>
                <Trash2 size={12} />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function formatRecentTime(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(timestamp);
}
