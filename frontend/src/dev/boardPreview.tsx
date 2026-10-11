import ReactDOM from "react-dom/client";
import { initialSanrenPieces } from "@sanguo/shared";
import { SanrenBoard } from "../components/SanrenBoard";
import "../styles/app.css";

const empty = new URLSearchParams(location.search).has("empty");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <div style={{ padding: 16, display: "flex", justifyContent: "center" }}>
    <div style={{ width: "min(92vw, 88vh)" }}>
      <SanrenBoard pieces={empty ? [] : initialSanrenPieces()} />
    </div>
  </div>,
);
