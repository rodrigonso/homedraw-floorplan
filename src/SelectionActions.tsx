import type { ReactNode } from "react";
import { Group, Trash2, Ungroup } from "lucide-react";

export function DeleteButton({ onDelete, children }: { onDelete: () => void; children: ReactNode }) {
  return <button className="danger-button" onClick={onDelete}><Trash2 size={15} />{children}</button>;
}

export function GroupActions({ canGroup, canUngroup, onChange }: {
  canGroup: boolean; canUngroup: boolean; onChange: (ungroup: boolean) => void;
}) {
  return <div className="group-actions">
    <button className="secondary-button" disabled={!canGroup} onClick={() => onChange(false)}
      title="Group (Ctrl/Cmd+G)"><Group size={15} /> Group selection</button>
    {canUngroup && <button className="secondary-button" onClick={() => onChange(true)}
      title="Ungroup (Ctrl/Cmd+Shift+G)"><Ungroup size={15} /> Ungroup selection</button>}
  </div>;
}
