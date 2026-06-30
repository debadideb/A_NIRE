import { createRoot } from "react-dom/client";
import App from "./app/App.tsx";
import { PopoutGraph } from "./app/components/PopoutGraph.tsx";
import "./styles/index.css";

// `?popout=<caseId>` renders just the graph (the separate pop-out window);
// otherwise the full console.
const popoutCase = new URLSearchParams(window.location.search).get("popout");

createRoot(document.getElementById("root")!).render(
  popoutCase ? <PopoutGraph caseId={popoutCase} /> : <App />,
);
