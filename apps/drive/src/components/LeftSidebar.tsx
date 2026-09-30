import { useDrive } from "../context";
import UploadPanel from "./UploadPanel";
import SearchPanel from "./SearchPanel";
import TagStrip from "./TagStrip";
import FileTypeStrip from "./FileTypeStrip";

export default function LeftSidebar() {
  const ctx = useDrive();

  return (
    <aside class="left-sidebar" classList={{ collapsed: !ctx.leftSidebarOpen() }}>
      <div class="left-sidebar-inner">
        <UploadPanel />
        <SearchPanel />
        <FileTypeStrip />
        <TagStrip />
      </div>
    </aside>
  );
}
