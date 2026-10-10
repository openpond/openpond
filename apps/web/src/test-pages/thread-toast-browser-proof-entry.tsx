import { createRoot } from "react-dom/client";
import { ThreadToastBrowserProof } from "./thread-toast-browser-proof";

const root = createRoot(document.getElementById("root")!);
root.render(<ThreadToastBrowserProof />);
import.meta.hot?.dispose(() => root.unmount());
