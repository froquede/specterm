import TerminalPane from "./components/TerminalPane";

export default function App() {
  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background: "#1a1b26",
      }}
    >
      <TerminalPane />
    </div>
  );
}
