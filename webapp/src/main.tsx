import { createRoot } from "react-dom/client";
import App from "./app/App.tsx";
import { PopoutGraph } from "./app/components/PopoutGraph.tsx";
import "./styles/index.css";

// `?popout=<caseId>` renders just the graph (the separate pop-out window);
// `&renderer=<id>` carries the view the user had selected. Otherwise the full
// console.
const params = new URLSearchParams(window.location.search);
const popoutCase = params.get("popout");
const popoutRenderer = params.get("renderer");

createRoot(document.getElementById("root")!).render(
  popoutCase ? (
    <PopoutGraph caseId={popoutCase} renderer={popoutRenderer ?? undefined} />
  ) : (
    <App />
  ),
);
